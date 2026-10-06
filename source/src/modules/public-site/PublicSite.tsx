import { useEffect, type ReactNode } from "react";

import { activeLanguage, chooseLanguage, readerLocale, t } from "../../lib/i18n";
import { LanguageSelect } from "../settings/LanguageSettings";
import "./publicSite.css";

export type PublicPage = "home" | "privacy" | "terms" | "support";

const SUPPORT_EMAIL = "support@claritygolf.app";

// When the privacy policy and terms last changed. Written out in the reader's
// language; the date itself is the English version's.
const LAST_UPDATED = new Date(Date.UTC(2026, 8, 30)).toLocaleDateString(readerLocale(), {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const pageTitles: Record<PublicPage, string> = {
  home: "Clarity Golf Booking",
  privacy: t("Privacy Policy · Clarity Golf Booking"),
  terms: t("Terms of Service · Clarity Golf Booking"),
  support: t("Support · Clarity Golf Booking"),
};

/**
 * A translated sentence with an element where its {link} is. The sentence is
 * translated whole, so each language puts the link where its grammar wants it.
 */
function withLink(sentence: string, link: ReactNode): ReactNode {
  const [before, after = ""] = sentence.split("{link}");
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}

/**
 * On the legal pages, in any language but English: the English text is the
 * one that binds. A machine translation of a privacy policy is a convenience,
 * not a second contract -- and Google's verification reads the English.
 */
function TranslationNotice() {
  if (activeLanguage() === "en") return null;
  return (
    <p className="public-updated">
      {withLink(
        t("This translation is provided for convenience. If it differs from the English version, the English version applies. {link}"),
        <button className="public-link-button" type="button" onClick={() => chooseLanguage("en")}>
          {t("Read it in English")}
        </button>,
      )}
    </p>
  );
}

function PublicHeader() {
  return (
    <header className="public-site-header">
      <a className="public-site-brand" href="/" aria-label={t("Clarity Golf Booking home")}>
        <img src="/assets/clarity-golf-logo-208.webp" alt="" width={208} height={208} />
        <span>
          <strong>{t("Clarity Golf")}</strong>
          <small>{t("Booking System")}</small>
        </span>
      </a>
      <nav aria-label={t("Public navigation")}>
        <a href="/privacy">{t("Privacy")}</a>
        <a href="/terms">{t("Terms")}</a>
        <a href="/support">{t("Support")}</a>
        <a className="public-site-sign-in" href="/login">{t("Sign in")}</a>
      </nav>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-site-footer">
      <span>Clarity Golf Booking</span>
      <nav aria-label={t("Legal and support")}>
        <a href="/privacy">{t("Privacy Policy")}</a>
        <a href="/terms">{t("Terms")}</a>
        <a href="/support">{t("Support")}</a>
      </nav>
      <LanguageSelect />
    </footer>
  );
}

function HomePage() {
  return (
    <>
      <section className="public-hero">
        <div>
          <p className="public-eyebrow">Clarity Golf Booking</p>
          <h1>{t("Booking and player management built for golf coaching.")}</h1>
          <p className="public-lead">{t("Clarity helps golf coaches manage lessons, availability, players, practice, passes and swing reviews in one connected workspace.")}</p>
          <div className="public-actions">
            <a className="public-primary-action" href="/login">{t("Sign in")}</a>
            <a className="public-secondary-action" href="https://book.claritygolf.app">{t("Book a lesson")}</a>
          </div>
        </div>
        <div className="public-summary-card" aria-label={t("Product summary")}>
          <img className="public-summary-logo" src="/assets/clarity-golf-logo-with-name.webp" alt="Clarity Golf" width={224} height={224} fetchPriority="high" />
          <span>{t("For coaches and their players")}</span>
          <strong>{t("One place for the work around the lesson.")}</strong>
          <p>{t("Scheduling, player history, coaching notes, practice, passes, video reviews and optional Google integrations.")}</p>
        </div>
      </section>

      <section className="public-feature-grid" aria-label={t("Clarity Golf Booking features")}>
        <article>
          <span>{t("01")}</span>
          <h2>{t("Booking & scheduling")}</h2>
          <p>{t("Coaches can manage services, availability, bookings, rescheduling and public lesson booking.")}</p>
        </article>
        <article>
          <span>{t("02")}</span>
          <h2>{t("Player management")}</h2>
          <p>{t("Keep player profiles, lesson history, notes, practice assignments, passes and swing reviews connected to the coaching relationship.")}</p>
        </article>
        <article>
          <span>{t("03")}</span>
          <h2>{t("Google Calendar")}</h2>
          <p>{t("A coach can choose to connect Google Calendar so Clarity can synchronise lesson bookings and relevant availability with the connected account.")}</p>
        </article>
        <article>
          <span>{t("04")}</span>
          <h2>{t("Clarity Cloud")}</h2>
          <p>{t("When enabled by the coach, Clarity can use Google Drive to create and manage Clarity-owned lesson video files and folders for transfer between devices.")}</p>
        </article>
      </section>

      <section className="public-trust-panel">
        <div>
          <p className="public-eyebrow">{t("Google integrations are optional")}</p>
          <h2>{t("You choose when Clarity connects to Google.")}</h2>
        </div>
        <p>
          {withLink(
            t("Google Calendar and Google Drive access is requested only when a coach enables the relevant integration. See the {link} for the exact Google data Clarity accesses and how it is used."),
            <a href="/privacy">{t("Privacy Policy")}</a>,
          )}
        </p>
      </section>
    </>
  );
}

function PrivacyPage() {
  return (
    <article className="public-legal">
      <p className="public-eyebrow">Clarity Golf Booking</p>
      <h1>{t("Privacy Policy")}</h1>
      <p className="public-updated">{t("Last updated {date}", { date: LAST_UPDATED })}</p>
      <TranslationNotice />

      <p>{t("This policy explains how Clarity Golf Booking (\"Clarity\", \"we\", \"us\") handles information when coaches, players and booking visitors use the service.")}</p>

      <h2>{t("Information we collect")}</h2>
      <p>{t("Depending on how Clarity is used, we may process account and profile information, contact details, booking and scheduling information, coaching notes, practice assignments, passes, transaction records, videos and other content that users choose to add to the service. We also process basic technical information needed to operate, secure and diagnose the service.")}</p>

      <h2>{t("How we use information")}</h2>
      <p>{t("We use information to provide booking, player-management, coaching, communication, billing and video-transfer features; authenticate users; maintain the service; prevent misuse; troubleshoot problems; and comply with legal obligations.")}</p>

      <h2>{t("Google account and Google API data")}</h2>
      <p>{t("Google integrations are optional and are connected by a coach. Clarity requests only the permissions needed for the features the coach enables.")}</p>

      <h3>{t("Google Calendar")}</h3>
      <p>{t("Clarity may request access to Google Calendar events and the connected account's calendar list. We use this access to show/select relevant calendars, synchronise coaching bookings and availability, and create, update or remove calendar events when corresponding records change in Clarity.")}</p>

      <h3>{t("Google Drive / Clarity Cloud")}</h3>
      <p>
        {withLink(
          t("If Clarity Cloud is enabled, Clarity uses Google's {link} permission to create and manage files and folders that Clarity itself creates or that the user explicitly makes available to Clarity. This is used for lesson-video storage and transfer. Clarity does not request unrestricted access to every file in a user's Google Drive."),
          <code>drive.file</code>,
        )}
      </p>

      <h3>{t("Google account identity")}</h3>
      <p>{t("Clarity may access the email address associated with the connected Google account so the service can identify which account is connected and show that connection to the coach.")}</p>

      <h3>{t("Google authorisation storage")}</h3>
      <p>{t("To keep an integration working without asking the coach to reconnect for every sync, Clarity may retain a Google refresh token. Refresh tokens are encrypted and stored server-side. Google access and refresh tokens are not exposed to the normal browser application.")}</p>

      <h3>{t("Google API data use and sharing")}</h3>
      <p>{t("Information received from Google APIs is used only to provide and maintain the Google-connected features described above. We do not sell, rent or trade Google user data. We do not use it for advertising, and we do not use it to train artificial intelligence or machine-learning models.")}</p>
      <p>{t("We share, transfer or disclose Google user data only with the following parties:")}</p>
      <ul>
        <li>{t("The coach's own golf business in Clarity. Busy times imported from Google Calendar, with their event titles unless the coach chooses to hide them, are shown to the coach and to people in the same golf business who can view that coach's diary. Players and people booking a lesson only see that a time is unavailable and never see Google Calendar event details.")}</li>
        <li>{t("Our infrastructure providers, which process data only on our behalf and under our instructions to run Clarity: Netlify, which hosts the application and its server functions, and Supabase, which hosts the database where Google-derived data and encrypted Google refresh tokens are stored.")}</li>
        <li>{t("Authorities or other parties where we are required to by law, such as to comply with a valid legal request, or where necessary to protect the rights, safety and security of our users or Clarity.")}</li>
        <li>{t("A successor organisation if Clarity is involved in a merger, acquisition or sale of assets. Any successor must continue to protect Google user data under this policy and the Limited Use requirements, and we will notify affected users first.")}</li>
      </ul>
      <p>{t("We do not share Google user data with any other third party, including advertisers, data brokers and artificial intelligence providers.")}</p>
      <p>
        {withLink(
          t("Clarity Golf Booking's use and transfer of information received from Google APIs adheres to the {link}, including the Limited Use requirements."),
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer noopener"
          >
            Google API Services User Data Policy
          </a>,
        )}
      </p>

      <h2>{t("Sharing")}</h2>
      <p>{t("We share information only where needed to provide the service, where a user directs us to do so, with providers that help us operate the service, or where required by law. Coaches and players may also see information that is intentionally shared within their coaching relationship.")}</p>

      <h2>{t("Retention and deletion")}</h2>
      <p>{t("We retain information for as long as it is reasonably needed to provide the service, maintain legitimate business records, resolve disputes and meet legal obligations. Retention periods can differ by data type. Users can request deletion or help with their account through Support.")}</p>

      <h2>{t("Disconnecting Google")}</h2>
      <p>{t("A coach can disconnect a Google integration from Clarity. Disconnecting stops future authorised Google access through that connection. Existing calendar events or Drive files already created in the user's Google account are not automatically deleted unless the product explicitly offers that action.")}</p>

      <h2>{t("Security")}</h2>
      <p>{t("We use technical and organisational safeguards designed to protect information, including access controls and encryption for stored Google refresh tokens. No system can guarantee absolute security.")}</p>

      <h2>{t("Contact")}</h2>
      <p>
        {withLink(
          t("Privacy questions, account requests and deletion requests can be sent to {link}."),
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>,
        )}
      </p>
    </article>
  );
}

function TermsPage() {
  return (
    <article className="public-legal">
      <p className="public-eyebrow">Clarity Golf Booking</p>
      <h1>{t("Terms of Service")}</h1>
      <p className="public-updated">{t("Last updated {date}", { date: LAST_UPDATED })}</p>
      <TranslationNotice />

      <p>{t("These terms apply when you access or use Clarity Golf Booking. By using the service, you agree to use it lawfully and in accordance with these terms.")}</p>

      <h2>{t("The service")}</h2>
      <p>{t("Clarity provides software for golf-coaching booking, scheduling, player management, practice, notes, passes, video reviews and related integrations. Individual coaches and businesses remain responsible for the coaching services, prices, cancellations and other arrangements they offer to players.")}</p>

      <h2>{t("Your account")}</h2>
      <p>{t("You are responsible for keeping your login credentials secure and for activity carried out through your account. Information you provide must be accurate enough for the service to operate correctly.")}</p>

      <h2>{t("Connected services")}</h2>
      <p>{t("Optional integrations, including Google Calendar and Google Drive, are also subject to the terms of those providers. You can disconnect optional integrations when you no longer want Clarity to access them.")}</p>

      <h2>{t("Your content")}</h2>
      <p>{t("You retain ownership of content you provide to Clarity. You give Clarity permission to process that content only as needed to provide, secure and maintain the service and the features you choose to use.")}</p>

      <h2>{t("Acceptable use")}</h2>
      <p>{t("You must not misuse the service, attempt unauthorised access, interfere with its operation, use it to infringe another person's rights, or upload unlawful or malicious material.")}</p>

      <h2>{t("Availability and changes")}</h2>
      <p>{t("We may maintain, improve or change the service over time. We aim to provide a reliable service but do not promise that every feature will be uninterrupted or error-free.")}</p>

      <h2>{t("Contact")}</h2>
      <p>
        {withLink(
          t("Questions about these terms can be sent to {link}."),
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>,
        )}
      </p>
    </article>
  );
}

function SupportPage() {
  return (
    <article className="public-legal public-support">
      <p className="public-eyebrow">Clarity Golf Booking</p>
      <h1>{t("Support")}</h1>
      <p>
        {withLink(
          t("For technical help with Clarity Golf Booking, account access, privacy requests or a problem with a connected service, email {link}."),
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>,
        )}
      </p>

      <h2>{t("Booking or lesson questions")}</h2>
      <p>{t("If your question is about a lesson time, cancellation, coaching service or payment arranged with a coach, contact the coach or golf business that provided your booking link. Those arrangements are managed by the individual business.")}</p>

      <h2>{t("Google connection help")}</h2>
      <p>{t("Coaches can manage Google Calendar and Clarity Cloud connections from the integrations area after signing in. If a connection needs to be reset or removed and you cannot access the app, contact Support.")}</p>

      <div className="public-actions">
        <a className="public-primary-action" href={`mailto:${SUPPORT_EMAIL}`}>{t("Email support")}</a>
        <a className="public-secondary-action" href="/login">{t("Sign in")}</a>
      </div>
    </article>
  );
}

export default function PublicSite({ page }: { page: PublicPage }) {
  useEffect(() => {
    document.title = pageTitles[page];
  }, [page]);

  return (
    <div className="public-site-shell">
      <PublicHeader />
      <main className="public-site-main">
        {page === "home" ? <HomePage /> : null}
        {page === "privacy" ? <PrivacyPage /> : null}
        {page === "terms" ? <TermsPage /> : null}
        {page === "support" ? <SupportPage /> : null}
      </main>
      <PublicFooter />
    </div>
  );
}
