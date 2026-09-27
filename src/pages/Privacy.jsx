import React from 'react'
import LegalPage from '../components/LegalPage.jsx'
import Link from '../components/Link.jsx'
import styles from '../components/LegalPage.module.css'

const CONTACT = 'manilbg157@gmail.com'
const UPDATED = '27 September 2026'

// The Privacy Policy. Every claim here was checked against the code rather than
// written from habit — the stores that exist (server/auth-core.js), what is
// encrypted (server/crypt.js), the sign-in trace and the IP lookups behind it
// (server/tracing.js, server/geoip.js), the cookie names, the browser keys
// (src/lib/*), and how an account is deleted (the settings screen, proved by a
// code mailed to the address on the account). If any of that changes, this page
// has to change with it.
export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="What Lumiere collects, where it is kept, who else sees it, and how to have it deleted."
      canonical="/privacy"
      updated={UPDATED}
    >
      <p className={styles.summary}>
        <strong>In one paragraph:</strong> we keep your email address, a scrambled
        version of your password, and what you watch, on the machine that runs this
        site — encrypted at rest. There is no analytics, no advertising, and nothing is
        sold or shared for marketing. Audio and video are never recorded; playback comes
        from third-party players you choose. You can ask us to delete your account and
        everything in it at any time.
      </p>

      <h2>1. What we collect</h2>
      <h3>Account details</h3>
      <ul>
        <li>
          Your <strong>email address</strong>, which is the key your account is stored
          under.
        </li>
        <li>
          A <strong>salted scrypt hash</strong> of your password, if you set one. We
          never store the password itself and cannot recover it — a forgotten password
          has to be reset.
        </li>
        <li>
          Whether the account <strong>signs in with Google</strong>. If you use Google
          sign-in, Google tells us your email address, display name and profile picture;
          we store the email address as the account key and do not keep the rest.
        </li>
      </ul>

      <h3>What you do in the Service</h3>
      <ul>
        <li>
          Your <strong>watch activity</strong>: which titles you played, when, and how
          far you got, so &ldquo;Continue Watching&rdquo; can resume in the right place.
        </li>
        <li>
          Your <strong>My List, likes and saved titles</strong>, and whether you have
          seen your notifications.
        </li>
        <li>
          Your <strong>choices on this device</strong>: whether you asked to be kept
          signed in, and per-tab interface state such as where to return after signing
          in.
        </li>
      </ul>

      <h3>Technical information</h3>
      <p>
        Your IP address and basic request information (the page asked for, the time) are
        processed <em>in memory</em> to rate-limit sign-in attempts and to serve the
        right page for the site you asked for, and are discarded as those limits expire.
      </p>
      <p>
        When you <strong>sign in or create an account</strong>, we also write down that
        it happened: the time, the IP address you connected from, the browser you used,
        roughly where that address is (city, region, country), the network it belongs to,
        and whether the address appears to be a VPN, proxy or Tor exit. This is kept to
        protect accounts — it is how a sign-in from somewhere you have never been can be
        noticed — and it is stored on the same machine as everything else, in a file named
        after your account&apos;s internal id rather than your email address.
      </p>

      <h2>2. What we do not collect</h2>
      <ul>
        <li>No analytics, telemetry or crash reporting.</li>
        <li>No advertising, advertising identifiers, or third-party trackers.</li>
        <li>No location data, contact list, or device sensor data.</li>
        <li>
          No audio or video is ever recorded or stored — playback happens inside a
          third party&apos;s player.
        </li>
        <li>We do not sell, rent or share your personal data for marketing.</li>
      </ul>

      <h2>3. Where your data is kept</h2>
      <p>
        On the host machine that runs the Service (our hosting provider,
        AlwaysData). It is not copied anywhere else by us, and there is no external
        database or third-party backend.
      </p>
      <ul>
        <li>
          The stored records are <strong>encrypted at rest</strong> with AES-256-GCM
          under a key held on the same machine. Identifiers that could point at a
          person — an email address, a token — are stored only as keyed HMAC values, so
          the files cannot be read by opening them.
        </li>
        <li>
          Passwords are stored as <strong>salted scrypt hashes</strong>. Sign-in and
          password-reset tokens are stored only as <strong>SHA-256 hashes</strong>; the
          real token exists only in the email sent to you and in your browser.
        </li>
        <li>
          Your browser holds only an <strong>HttpOnly session cookie</strong> that
          identifies your session. JavaScript on the page cannot read it.
        </li>
      </ul>

      <h2>4. Cookies and local storage</h2>
      <ul>
        <li>
          <strong>One session cookie</strong> — identifies you while you are signed in.
          It is HttpOnly and, over HTTPS, Secure.
        </li>
        <li>
          <strong>One short-lived cookie during Google sign-in</strong> — protects the
          sign-in round trip from being hijacked. It expires within ten minutes.
        </li>
        <li>
          <strong>Per-tab session storage</strong> — whether you chose to browse without
          signing in, where to send you back to, and whether the opening splash has
          already played. It is gone when the tab closes.
        </li>
        <li>
          <strong>Local storage</strong> — your &ldquo;keep me logged in&rdquo; choice,
          the locally cached copy of your saved titles, and, in the Android app build
          only, a session token used instead of a cookie.
        </li>
      </ul>
      <p>
        There are no advertising or tracking cookies, and nothing here follows you to
        other websites.
      </p>

      <h2>5. Who else is involved</h2>
      <p>Data reaches these third parties only as described:</p>
      <ul>
        <li>
          <strong>TMDB</strong> — the source of the metadata and artwork. Those requests
          are proxied through our own server, so TMDB does not receive your IP address
          from your browser.
        </li>
        <li>
          <strong>Google</strong> — if you choose Google sign-in, the sign-in exchange
          goes to Google. Fonts on the page are also loaded from Google.
        </li>
        <li>
          <strong>Streaming players</strong> — VidLink, VidLove, VidSrc, 2Embed and
          NexStream. <em>Only the player you actually select is loaded.</em> Once it is,
          it is a separate website inside the page and may collect data about you under
          its own privacy policy, which we do not control. Using one of these players is
          what shares your IP address and playback request with that provider.
        </li>
        <li>
          <strong>AlwaysData</strong> — our hosting provider, which stores the files
          described above on our behalf.
        </li>
        <li>
          <strong>Our email service</strong> — used only to send you password-reset
          messages when you ask for one.
        </li>
        <li>
          <strong>IP address databases</strong> — to say where a sign-in came from and
          whether it was a VPN, the IP address is looked up through a geolocation service
          (ipstack and positionstack, with fallbacks). <em>This is the one thing about you
          that leaves our machine</em>: the address, and nothing else — no email, no
          account id, no history. Nothing about the lookup is stored by us beyond the
          result, and the answer is cached so the same address is not looked up twice.
        </li>
      </ul>

      <h2>6. Email</h2>
      <p>
        We send email only for things you asked for — a password reset, or a message
        about your account. We do not send marketing, and we do not share your address
        with anyone.
      </p>

      <h2>7. How long we keep it</h2>
      <p>
        Account details and activity are kept while your account exists. Sessions expire
        and are pruned automatically; password-reset tokens are single-use and expire
        shortly after they are requested. When your account is deleted, the associated
        records are removed.
      </p>
      <p>
        The sign-in record described above is kept for <strong>180 days</strong> (the
        daily files are deleted automatically after that), and the copy filed under your
        account is kept for as long as the account is — it is deleted with the account.
      </p>

      <h2>8. Your choices and your rights</h2>
      <p>
        You can read, correct, export or delete your information. Depending on where you
        live you may have a legal right to access, correct, delete, restrict or object to
        processing, and to data portability.
      </p>
      <p>
        You can change your email address, your password, the Google account linked to
        it, your gender and date of birth, and you can <strong>delete your account and
        everything in it</strong>, yourself, on the User Settings screen — every one of
        those steps is proved by a short code mailed to the address on the account, so a
        stolen session cannot do any of them. Deleting it removes the account, its
        sessions, its watch history, its lists, its offline list, its registered devices,
        its photo and its own sign-in record; the address can be registered again
        afterwards. For anything else — a copy of your data, or a question about it —
        write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address on the
        account.
      </p>

      <h2>9. Children</h2>
      <p>
        The Service is not intended for children under 13, and we do not knowingly
        collect their personal data. If you believe a child has given us their details,
        write to us and we will remove them.
      </p>

      <h2>10. Security</h2>
      <p>
        We use encryption at rest, hashed credentials, HttpOnly session cookies, and
        request limits on sign-in attempts. No system is perfect, and we cannot promise
        absolute security — but we do not hold payment details, and the data at risk is
        limited to what is described above.
      </p>
      <p>
        One operational note: the encryption key for the stored records lives on the host
        as a single file. It is backed up by the operator. Without it, the encrypted
        records cannot be read by anyone, including us.
      </p>

      <h2>11. Transfers</h2>
      <p>
        The Service is operated from, and its data stored on, servers that may be in a
        country other than yours, including by the hosting provider named above. By
        using the Service you understand your information may be handled there.
      </p>

      <h2>12. Changes to this policy</h2>
      <p>
        We may update this policy. The date at the top changes when we do, and material
        changes will be made clear on the Service.
      </p>

      <h2>13. Contact</h2>
      <p className={styles.contact}>
        For any privacy question, or a data request:{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>

      <p className={styles.contact}>
        See also the <Link to="/terms">Terms of Service</Link>.
      </p>
    </LegalPage>
  )
}
