package app.claritygolf.terminal

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider
import com.stripe.stripeterminal.external.callable.DiscoveryListener
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TapToPayReaderListener
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.ConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionStatus
import com.stripe.stripeterminal.external.models.ConnectionTokenException
import com.stripe.stripeterminal.external.models.DeviceType
import com.stripe.stripeterminal.external.models.DisconnectReason
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration
import com.stripe.stripeterminal.external.models.LocaleConfig
import com.stripe.stripeterminal.external.models.PaymentIntent
import com.stripe.stripeterminal.external.models.PaymentIntentStatus
import com.stripe.stripeterminal.external.models.Reader
import com.stripe.stripeterminal.external.models.ReaderSupportResult
import com.stripe.stripeterminal.external.models.TapUseCase
import com.stripe.stripeterminal.external.models.TerminalErrorCode
import com.stripe.stripeterminal.external.models.TerminalException
import com.stripe.stripeterminal.log.LogLevel
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tap to Pay on Android for Clarity Booking. The twin of the iPhone plugin
 * (ios/Sources/ClarityTerminalPlugin): same name, same methods, same events,
 * same results, so the page never has to care which phone it is on.
 *
 * Deliberately thin. This plugin never decides an amount, never talks to
 * Clarity's API and never holds a Stripe key. The page (the live Booking site,
 * loaded in this app's WebView with the coach's normal session) asks the server
 * for everything and hands the plugin only what the Terminal SDK needs:
 *
 *   - a connection token, whenever the SDK asks for one. The plugin raises a
 *     `connectionTokenRequest` event; the page fetches
 *     /api/billing/terminal/connection-token and answers with
 *     `provideConnectionToken`. Tokens are never cached here.
 *   - the Stripe Terminal location to connect at.
 *   - the client secret of a PaymentIntent the server created and priced.
 *
 * After a tap the plugin reports what the SDK said, and the page asks the
 * server what actually happened. The server's answer is the one that counts.
 *
 * Unlike the iPhone, Stripe draws the tap screen itself on Android (its own
 * full-screen activity), so there are no reader messages to pass on.
 */
@CapacitorPlugin(
    name = "ClarityTerminal",
    permissions = [
        Permission(alias = ClarityTerminalPlugin.LOCATION, strings = [Manifest.permission.ACCESS_COARSE_LOCATION]),
        // Android 11 and older want fine location as well.
        Permission(
            alias = ClarityTerminalPlugin.LOCATION_LEGACY,
            strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION],
        ),
    ],
)
class ClarityTerminalPlugin : Plugin() {
    companion object {
        const val LOCATION = "location"
        const val LOCATION_LEGACY = "locationLegacy"
    }

    private val tokenBridge = TokenBridge()
    private var discoverCancelable: Cancelable? = null
    private var collectCancelable: Cancelable? = null
    private var connectedLocationId = ""

    override fun load() {
        tokenBridge.plugin = this
        // Once per process. Survives the WebView reloading the page.
        if (!Terminal.isInitialized()) {
            Terminal.init(
                context.applicationContext,
                LogLevel.WARNING,
                tokenBridge,
                object : TerminalListener {},
                null,
                // Stripe's tap screen speaks the card's language when it can.
                LocaleConfig.CardLanguagePreferenceIfAvailable,
            )
        }
    }

    // --- Support -------------------------------------------------------------

    /**
     * Can this phone take Tap to Pay at all? Says nothing about the business;
     * the server answers that half (GET /api/billing/terminal/status).
     * Stripe's own check covers NFC, Android version and a phone it trusts.
     */
    @PluginMethod
    fun isSupported(call: PluginCall) {
        val simulated = call.getBoolean("simulated", false) == true
        if (!simulated && !context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC)) {
            call.resolve(supported(false, "This phone has no NFC, so it cannot take Tap to Pay."))
            return
        }
        val result = Terminal.getInstance().supportsReadersOfType(
            DeviceType.TAP_TO_PAY_DEVICE,
            DiscoveryConfiguration.TapToPayDiscoveryConfiguration(simulated),
        )
        when (result) {
            is ReaderSupportResult.NotSupported ->
                call.resolve(supported(false, result.error.message ?: "This phone cannot take Tap to Pay."))
            else -> call.resolve(supported(true, ""))
        }
    }

    private fun supported(yes: Boolean, reason: String) = JSObject().put("supported", yes).put("reason", reason)

    // --- Connecting ----------------------------------------------------------

    /**
     * Location permission, then discover and connect this phone's Tap to Pay
     * reader at the given Stripe Terminal location. Safe to call again: an
     * existing connection at the same location is kept.
     */
    @PluginMethod
    fun prepare(call: PluginCall) {
        val locationId = call.getString("stripeLocationId").orEmpty()
        if (locationId.isEmpty()) {
            call.reject("A Stripe Terminal location is required.", "LOCATION_REQUIRED")
            return
        }
        if (Terminal.getInstance().connectionStatus == ConnectionStatus.CONNECTED && connectedLocationId == locationId) {
            call.resolve(JSObject().put("connected", true))
            return
        }
        val alias = locationAlias()
        if (getPermissionState(alias) == PermissionState.GRANTED) {
            connect(call)
        } else {
            requestPermissionForAlias(alias, call, "locationAnswered")
        }
    }

    @PermissionCallback
    private fun locationAnswered(call: PluginCall) {
        if (getPermissionState(locationAlias()) != PermissionState.GRANTED) {
            call.reject(
                "Location access is off. Turn it on for Clarity Booking in Settings to take card payments.",
                "LOCATION_DENIED",
            )
            return
        }
        connect(call)
    }

    private fun locationAlias() = if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) LOCATION_LEGACY else LOCATION

    private fun connect(call: PluginCall) {
        val locationId = call.getString("stripeLocationId").orEmpty()
        val simulated = call.getBoolean("simulated", false) == true
        // Discovery and connection report through different callbacks; the
        // call is answered by whichever settles it first.
        val settled = AtomicBoolean(false)
        val discover = {
            discoverCancelable = Terminal.getInstance().discoverReaders(
                DiscoveryConfiguration.TapToPayDiscoveryConfiguration(simulated),
                object : DiscoveryListener {
                    private var handled = false

                    override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                        val reader = readers.firstOrNull() ?: return
                        if (handled) return
                        handled = true
                        connectReader(reader, locationId, call, settled)
                    }
                },
                object : Callback {
                    override fun onSuccess() {}

                    override fun onFailure(e: TerminalException) {
                        if (e.errorCode != TerminalErrorCode.CANCELED && settled.compareAndSet(false, true)) {
                            reject(call, e, "DISCOVERY_FAILED")
                        }
                    }
                },
            )
        }
        if (Terminal.getInstance().connectionStatus == ConnectionStatus.CONNECTED) {
            // Connected somewhere else: move to this location.
            Terminal.getInstance().disconnectReader(object : Callback {
                override fun onSuccess() = discover()

                override fun onFailure(e: TerminalException) = discover()
            })
        } else {
            discover()
        }
    }

    private fun connectReader(reader: Reader, locationId: String, call: PluginCall, settled: AtomicBoolean) {
        val config = ConnectionConfiguration.TapToPayConnectionConfiguration(TapUseCase.Pay(locationId), true, readerListener)
        Terminal.getInstance().connectReader(reader, config, object : ReaderCallback {
            override fun onSuccess(reader: Reader) {
                connectedLocationId = locationId
                if (settled.compareAndSet(false, true)) call.resolve(JSObject().put("connected", true))
            }

            override fun onFailure(e: TerminalException) {
                if (settled.compareAndSet(false, true)) reject(call, e, "CONNECT_FAILED")
            }
        })
    }

    private val readerListener = object : TapToPayReaderListener {
        override fun onDisconnect(reason: DisconnectReason) {
            connectedLocationId = ""
            notifyListeners("disconnected", JSObject())
        }
    }

    // --- Paying --------------------------------------------------------------

    /**
     * Collect a card for a PaymentIntent the server created, then confirm it.
     *
     * `stage` in the result tells the page how much it can trust a failure:
     * a failure at "collect" means no card was charged and the tap can be
     * offered again; anything at "confirm" may or may not have charged, and
     * the page must ask the server before doing anything else.
     */
    @PluginMethod
    fun collectPayment(call: PluginCall) {
        val clientSecret = call.getString("clientSecret").orEmpty()
        if (clientSecret.isEmpty()) {
            call.reject("A payment to collect is required.", "PAYMENT_REQUIRED")
            return
        }
        Terminal.getInstance().retrievePaymentIntent(clientSecret, object : PaymentIntentCallback {
            override fun onFailure(e: TerminalException) = call.resolve(outcome("failed", "retrieve", e))

            override fun onSuccess(paymentIntent: PaymentIntent) {
                collectCancelable = Terminal.getInstance().collectPaymentMethod(paymentIntent, object : PaymentIntentCallback {
                    override fun onFailure(e: TerminalException) {
                        collectCancelable = null
                        val cancelled = e.errorCode == TerminalErrorCode.CANCELED
                        call.resolve(outcome(if (cancelled) "cancelled" else "failed", "collect", e))
                    }

                    override fun onSuccess(paymentIntent: PaymentIntent) {
                        collectCancelable = null
                        confirm(paymentIntent, call)
                    }
                })
            }
        })
    }

    private fun confirm(collected: PaymentIntent, call: PluginCall) {
        Terminal.getInstance().confirmPaymentIntent(collected, object : PaymentIntentCallback {
            override fun onSuccess(paymentIntent: PaymentIntent) {
                call.resolve(
                    JSObject()
                        .put("outcome", "confirmed")
                        .put("stage", "confirm")
                        .put("paymentIntentId", paymentIntent.id.orEmpty())
                        .put("status", if (paymentIntent.status == PaymentIntentStatus.SUCCEEDED) "succeeded" else "processing"),
                )
            }

            override fun onFailure(e: TerminalException) = call.resolve(outcome("failed", "confirm", e))
        })
    }

    /**
     * Stop waiting for a card. Only works before a card is read; after that
     * the payment runs to its end and the page reconciles.
     */
    @PluginMethod
    fun cancel(call: PluginCall) {
        val cancelable = collectCancelable
        if (cancelable == null || cancelable.isCompleted) {
            call.resolve(JSObject().put("cancelled", false))
            return
        }
        cancelable.cancel(object : Callback {
            override fun onSuccess() = call.resolve(JSObject().put("cancelled", true))

            override fun onFailure(e: TerminalException) = call.resolve(JSObject().put("cancelled", false))
        })
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        discoverCancelable?.takeIf { !it.isCompleted }?.cancel(NoOp)
        if (Terminal.getInstance().connectionStatus != ConnectionStatus.CONNECTED) {
            call.resolve()
            return
        }
        Terminal.getInstance().disconnectReader(object : Callback {
            override fun onSuccess() {
                connectedLocationId = ""
                call.resolve()
            }

            override fun onFailure(e: TerminalException) = call.resolve()
        })
    }

    // --- Merchant education --------------------------------------------------

    /**
     * Android has no system "How to Tap" guide like Apple's, so this always
     * says so and the page shows its own short instructions. Kept so the page
     * calls the same plugin on both phones.
     */
    @PluginMethod
    fun showHowToTap(call: PluginCall) {
        call.resolve(JSObject().put("shown", false))
    }

    // --- Connection tokens ---------------------------------------------------

    /** The page's answer to a `connectionTokenRequest` event. */
    @PluginMethod
    fun provideConnectionToken(call: PluginCall) {
        tokenBridge.answer(call.getString("requestId").orEmpty(), call.getString("secret"), call.getString("error"))
        call.resolve()
    }

    internal fun requestConnectionToken(requestId: String) {
        notifyListeners("connectionTokenRequest", JSObject().put("requestId", requestId))
    }

    // --- Helpers -------------------------------------------------------------

    private fun outcome(outcome: String, stage: String, error: TerminalException): JSObject {
        val result = JSObject()
            .put("outcome", outcome)
            .put("stage", stage)
            .put("message", error.errorMessage)
            .put("code", error.errorCode.name)
        error.apiError?.declineCode?.let { result.put("declineCode", it) }
        error.paymentIntent?.id?.let { result.put("paymentIntentId", it) }
        return result
    }

    /**
     * The SDK's own message is already written for a person (unsupported
     * phone, NFC off, location off), so it is passed through as is, with
     * Stripe's error code for logs.
     */
    private fun reject(call: PluginCall, error: TerminalException, fallbackCode: String) {
        call.reject(error.errorMessage, fallbackCode, error, JSObject().put("sdkCode", error.errorCode.name))
    }
}

private object NoOp : Callback {
    override fun onSuccess() {}

    override fun onFailure(e: TerminalException) {}
}

/**
 * The SDK's ConnectionTokenProvider, answered by the page.
 *
 * The SDK asks whenever it needs a token (connecting, reconnecting, after one
 * expires). Each ask becomes an event with its own id; the page fetches a
 * fresh token from Clarity's server and answers that id.
 */
private class TokenBridge : ConnectionTokenProvider {
    var plugin: ClarityTerminalPlugin? = null
    private val pending = ConcurrentHashMap<String, ConnectionTokenCallback>()
    private val main = Handler(Looper.getMainLooper())

    override fun fetchConnectionToken(callback: ConnectionTokenCallback) {
        val requestId = UUID.randomUUID().toString()
        pending[requestId] = callback
        val plugin = plugin
        if (plugin == null) {
            answer(requestId, null, "Tap to Pay is not ready.")
            return
        }
        plugin.requestConnectionToken(requestId)
        // Never leave the SDK waiting forever on a page that went away.
        main.postDelayed({ answer(requestId, null, "Timed out getting permission from Clarity.") }, 30_000)
    }

    fun answer(requestId: String, secret: String?, message: String?) {
        val callback = pending.remove(requestId) ?: return
        if (!secret.isNullOrEmpty()) {
            callback.onSuccess(secret)
        } else {
            callback.onFailure(ConnectionTokenException(message ?: "Clarity did not provide a connection token."))
        }
    }
}
