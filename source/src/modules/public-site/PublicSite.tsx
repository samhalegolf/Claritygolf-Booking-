import { useEffect } from "react";

import "./publicSite.css";

export type PublicPage = "home" | "privacy" | "terms" | "support";

const SUPPORT_EMAIL = "support@claritygolf.app";

const pageTitles: Record<PublicPage, string> = {
  home: "Clarity Golf Booking",
  privacy: "Privacy Policy · Clarity Golf Booking",
  terms: "Terms of Service · Clarity Golf Booking",
  support: "Support · Clarity Golf Booking",
};

function PublicHeader() {
  return (
    <header className="public-site-header">
      <a className="public-site-brand" href="/" aria-label="Clarity Golf Booking home">
        <img src="/assets/clarity-golf-logo-208.png" alt="" />
        <span>
          <strong>Clarity Golf</strong>
          <small>Booking System</small>
        </span>
      </a>
      <nav aria-label="Public navigation">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/support">Support</a>
        <a className="public-site-sign-in" href="/login">Sign in</a>
      </nav>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-site-footer">
      <span>Clarity Golf Booking</span>
      <nav aria-label="Legal and support">
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms</a>
        <a href="/support">Support</a>
      </nav>
    </footer>
  );
}

function HomePage() {
  return (
    <>
      <section className="public-hero">
        <div>
          <p className="public-eyebrow">Clarity Golf Booking</p>
          <h1>Booking and player management built for golf coaching.</h1>
          <p className="public-lead">
            Clarity helps golf coaches manage lessons, availability, players, practice,
            passes and swing reviews in one connected workspace.
          </p>
          <div className="public-actions">
            <a className="public-primary-action" href="/login">Sign in</a>
            <a className="public-secondary-action" href="https://book.claritygolf.app">Book a lesson</a>
          </div>
        </div>
        <div className="public-summary-card" aria-label="Product summary">
          <span>For coaches and their players</span>
          <strong>One place for the work around the lesson.</strong>
          <p>
            Scheduling, player history, coaching notes, practice, passes, video reviews and
            optional Google integrations.
          </p>
        </div>
      </section>

      <section className="public-feature-grid" aria-label="Clarity Golf Booking features">
        <article>
          <span>01</span>
          <h2>Booking & scheduling</h2>
          <p>
            Coaches can manage services, availability, bookings, rescheduling and public
            lesson booking.
          </p>
        </article>
        <article>
          <span>02</span>
          <h2>Player management</h2>
          <p>
            Keep player profiles, lesson history, notes, practice assignments, passes and
            swing reviews connected to the coaching relationship.
          </p>
        </article>
        <article>
          <span>03</span>
          <h2>Google Calendar</h2>
          <p>
            A coach can choose to connect Google Calendar so Clarity can synchronise lesson
            bookings and relevant availability with the connected account.
          </p>
        </article>
        <article>
          <span>04</span>
          <h2>Clarity Cloud</h2>
          <p>
            When enabled by the coach, Clarity can use Google Drive to create and manage
            Clarity-owned lesson video files and folders for transfer between devices.
          </p>
        </article>
      </section>

      <section className="public-trust-panel">
        <div>
          <p className="public-eyebrow">Google integrations are optional</p>
          <h2>You choose when Clarity connects to Google.</h2>
        </div>
        <p>
          Google Calendar and Google Drive access is requested only when a coach enables the
          relevant integration. See the <a href="/privacy">Privacy Policy</a> for the exact
          Google data Clarity accesses and how it is used.
        </p>
      </section>
    </>
  );
}

function PrivacyPage() {
  return (
    <article className="public-legal">
      <p className="public-eyebrow">Clarity Golf Booking</p>
      <h1>Privacy Policy</h1>
      <p className="public-updated">Last updated 25 September 2026</p>

      <p>
        This policy explains how Clarity Golf Booking ("Clarity", "we", "us") handles
        information when coaches, players and booking visitors use the service.
      </p>

      <h2>Information we collect</h2>
      <p>
        Depending on how Clarity is used, we may process account and profile information,
        contact details, booking and scheduling information, coaching notes, practice
        assignments, passes, transaction records, videos and other content that users choose
        to add to the service. We also process basic technical information needed to operate,
        secure and diagnose the service.
      </p>

      <h2>How we use information</h2>
      <p>
        We use information to provide booking, player-management, coaching, communication,
        billing and video-transfer features; authenticate users; maintain the service; prevent
        misuse; troubleshoot problems; and comply with legal obligations.
      </p>

      <h2>Google account and Google API data</h2>
      <p>
        Google integrations are optional and are connected by a coach. Clarity requests only
        the permissions needed for the features the coach enables.
      </p>

      <h3>Google Calendar</h3>
      <p>
        Clarity may request access to Google Calendar events and the connected account's
        calendar list. We use this access to show/select relevant calendars, synchronise
        coaching bookings and availability, and create, update or remove calendar events when
        corresponding records change in Clarity.
      </p>

      <h3>Google Drive / Clarity Cloud</h3>
      <p>
        If Clarity Cloud is enabled, Clarity uses Google's <code>drive.file</code> permission
        to create and manage files and folders that Clarity itself creates or that the user
        explicitly makes available to Clarity. This is used for lesson-video storage and
        transfer. Clarity does not request unrestricted access to every file in a user's
        Google Drive.
      </p>

      <h3>Google account identity</h3>
      <p>
        Clarity may access the email address associated with the connected Google account so
        the service can identify which account is connected and show that connection to the
        coach.
      </p>

      <h3>Google authorisation storage</h3>
      <p>
        To keep an integration working without asking the coach to reconnect for every sync,
        Clarity may retain a Google refresh token. Refresh tokens are encrypted and stored
        server-side. Google access and refresh tokens are not exposed to the normal browser
        application.
      </p>

      <h3>Google API data use and sharing</h3>
      <p>
        Information received from Google APIs is used only to provide and maintain the
        Google-connected features described above. We do not sell Google user data or use it
        for advertising. We may use infrastructure and service providers where necessary to
        operate Clarity, subject to appropriate confidentiality and security obligations.
      </p>
      <p>
        Clarity Golf Booking's use and transfer of information received from Google APIs
        adheres to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer noopener"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>Sharing</h2>
      <p>
        We share information only where needed to provide the service, where a user directs
        us to do so, with providers that help us operate the service, or where required by
        law. Coaches and players may also see information that is intentionally shared within
        their coaching relationship.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        We retain information for as long as it is reasonably needed to provide the service,
        maintain legitimate business records, resolve disputes and meet legal obligations.
        Retention periods can differ by data type. Users can request deletion or help with
        their account through Support.
      </p>

      <h2>Disconnecting Google</h2>
      <p>
        A coach can disconnect a Google integration from Clarity. Disconnecting stops future
        authorised Google access through that connection. Existing calendar events or Drive
        files already created in the user's Google account are not automatically deleted
        unless the product explicitly offers that action.
      </p>

      <h2>Security</h2>
      <p>
        We use technical and organisational safeguards designed to protect information,
        including access controls and encryption for stored Google refresh tokens. No system
        can guarantee absolute security.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions, account requests and deletion requests can be sent to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </article>
  );
}

function TermsPage() {
  return (
    <article className="public-legal">
      <p className="public-eyebrow">Clarity Golf Booking</p>
      <h1>Terms of Service</h1>
      <p className="public-updated">Last updated 25 September 2026</p>

      <p>
        These terms apply when you access or use Clarity Golf Booking. By using the service,
        you agree to use it lawfully and in accordance with these terms.
      </p>

      <h2>The service</h2>
      <p>
        Clarity provides software for golf-coaching booking, scheduling, player management,
        practice, notes, passes, video reviews and related integrations. Individual coaches
        and businesses remain responsible for the coaching services, prices, cancellations
        and other arrangements they offer to players.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for keeping your login credentials secure and for activity carried
        out through your account. Information you provide must be accurate enough for the
        service to operate correctly.
      </p>

      <h2>Connected services</h2>
      <p>
        Optional integrations, including Google Calendar and Google Drive, are also subject to
        the terms of those providers. You can disconnect optional integrations when you no
        longer want Clarity to access them.
      </p>

      <h2>Your content</h2>
      <p>
        You retain ownership of content you provide to Clarity. You give Clarity permission to
        process that content only as needed to provide, secure and maintain the service and
        the features you choose to use.
      </p>

      <h2>Acceptable use</h2>
      <p>
        You must not misuse the service, attempt unauthorised access, interfere with its
        operation, use it to infringe another person's rights, or upload unlawful or malicious
        material.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We may maintain, improve or change the service over time. We aim to provide a reliable
        service but do not promise that every feature will be uninterrupted or error-free.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms can be sent to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </article>
  );
}

function SupportPage() {
  return (
    <article className="public-legal public-support">
      <p className="public-eyebrow">Clarity Golf Booking</p>
      <h1>Support</h1>
      <p>
        For technical help with Clarity Golf Booking, account access, privacy requests or a
        problem with a connected service, email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>Booking or lesson questions</h2>
      <p>
        If your question is about a lesson time, cancellation, coaching service or payment
        arranged with a coach, contact the coach or golf business that provided your booking
        link. Those arrangements are managed by the individual business.
      </p>

      <h2>Google connection help</h2>
      <p>
        Coaches can manage Google Calendar and Clarity Cloud connections from the integrations
        area after signing in. If a connection needs to be reset or removed and you cannot
        access the app, contact Support.
      </p>

      <div className="public-actions">
        <a className="public-primary-action" href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
        <a className="public-secondary-action" href="/login">Sign in</a>
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
