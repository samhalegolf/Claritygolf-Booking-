package app.claritygolf.booking;

import android.app.Application;
import com.stripe.stripeterminal.TerminalApplicationDelegate;
import com.stripe.stripeterminal.taptopay.TapToPay;

/**
 * Stripe's Tap to Pay needs two things from the app itself, before anything
 * else runs. Neither can live in the plugin, because only the app owns its
 * Application class.
 *
 * Stripe runs the tap screen in a separate process of this same app, and that
 * process starts here too. It must be left alone: nothing of ours (Terminal,
 * the WebView) may start in it.
 */
public class ClarityBookingApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        if (TapToPay.isInTapToPayProcess()) return;
        TerminalApplicationDelegate.onCreate(this);
    }
}
