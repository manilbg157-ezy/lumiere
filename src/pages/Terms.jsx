import React from 'react'
import LegalPage from '../components/LegalPage.jsx'
import Link from '../components/Link.jsx'
import styles from '../components/LegalPage.module.css'

const CONTACT = 'manilbg157@gmail.com'
const UPDATED = '26 September 2026'

// The Terms of Service. Written against what this app actually does: it shows
// metadata from TMDB and plays titles through third-party embed players, and it
// hosts nothing itself. Kept in the same plain voice as the README for the same
// reason — a document nobody can read is not much of an agreement.
export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      description="The terms that govern your use of Lumiere — what the service is, what you may do with it, and what it is not responsible for."
      canonical="/terms"
      updated={UPDATED}
    >
      <p className={styles.summary}>
        <strong>In one paragraph:</strong> Lumiere is a catalogue and a player. It shows
        information about films and series and plays them through other people&apos;s
        players — it does not host any video itself. Use it lawfully, keep your account
        to yourself, and understand that the players and the titles come from third
        parties we do not control and cannot vouch for.
      </p>

      <h2>1. About these Terms</h2>
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of Lumiere (the
        &ldquo;Service&rdquo;), including the website and the mobile application. By
        using the Service you agree to them. If you do not agree, please do not use the
        Service.
      </p>

      <h2>2. What the Service is — and what it is not</h2>
      <p>
        The Service is a catalogue and a playback interface. It displays metadata,
        artwork and descriptions obtained from The Movie Database (&ldquo;TMDB&rdquo;),
        and it plays titles through embedded players operated by unrelated third
        parties.
      </p>
      <p>
        <strong>We do not host, store, upload, record or transmit any video.</strong>{' '}
        Every stream you watch is delivered by a third-party player that we embed and do
        not control. We claim no rights in any film, series, artwork or trademark shown
        in the Service, and nothing here grants you any such rights.
      </p>
      <p>
        We make no representation that any title listed is available, lawful, or
        appropriate in your country.
      </p>

      <h2>3. Eligibility</h2>
      <p>
        You must be at least 13 years old, and old enough in your country to consent to
        using an online service on your own. If you are younger, you may use the Service
        only with the involvement of a parent or guardian. You must not use the Service
        where doing so would break the law that applies to you.
      </p>

      <h2>4. Your account</h2>
      <ul>
        <li>Browsing is open to everyone; watching requires an account.</li>
        <li>
          You must give a valid email address that you control. You are responsible for
          everything done through your account and for keeping your password secret.
        </li>
        <li>
          You may sign in with Google instead of a password. That sign-in is also subject
          to Google&apos;s own terms.
        </li>
        <li>One account per email address, and no sharing or transferring accounts.</li>
        <li>
          Tell us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you believe someone
          else has access to your account.
        </li>
      </ul>

      <h2>5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the Service for anything unlawful, or to infringe anyone&apos;s rights;</li>
        <li>
          attempt to gain unauthorised access to any account, server or data, or to
          interfere with or overload the Service;
        </li>
        <li>
          scrape, crawl or automate requests at volume, or evade the request limits the
          Service applies;
        </li>
        <li>
          copy, resell, rebrand or otherwise commercialise the Service or its interface;
        </li>
        <li>
          attempt to obtain personal data about anyone else through the Service; or
        </li>
        <li>
          upload or send anything malicious, or use the Service to send unsolicited
          messages.
        </li>
      </ul>

      <h2>6. Third-party content and players</h2>
      <p>
        The embedded players are independent third parties. Your use of them is governed
        by their own terms and privacy policies, not these Terms, and what they show,
        whether they work, and whether they are lawful where you are is outside our
        control. We do not endorse them and we are not responsible for them.
      </p>
      <p>
        If you believe something reachable through the Service infringes your rights,
        write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a> with enough detail to
        identify it. We will look at it and remove the relevant listing or embed where
        that is the right thing to do.
      </p>

      <h2>7. Intellectual property</h2>
      <p>
        The Lumiere name, interface and code belong to the operator of the Service. TMDB
        metadata and artwork belong to TMDB and to the respective rights holders, and
        are used under TMDB&apos;s terms. Titles, posters and marks shown in the Service
        remain the property of their owners.
      </p>

      <h2>8. Availability and changes</h2>
      <p>
        The Service is free and provided on an &ldquo;as is&rdquo; and &ldquo;as
        available&rdquo; basis. There is no promise of uptime, and any part of it —
        including which players are offered — may change, be suspended or be withdrawn
        at any time without notice.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        To the fullest extent permitted by law, the Service is provided without
        warranties of any kind, express or implied, including any implied warranty of
        merchantability, fitness for a particular purpose, or non-infringement. We do not
        warrant that the Service will be uninterrupted, secure or free of errors, or that
        any title will be available or will play.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, we are not liable for any indirect,
        incidental, special, consequential or punitive damages, or for any loss of data,
        profits, or goodwill, arising out of or relating to your use of the Service —
        including anything that happens on a third-party player. Where liability cannot
        be excluded, it is limited to the amount you have paid us for the Service, which
        is nothing.
      </p>
      <p>
        Nothing in these Terms excludes liability that cannot lawfully be excluded, and
        nothing here affects rights you have as a consumer under the law that applies to
        you.
      </p>

      <h2>11. Suspension and termination</h2>
      <p>
        You may stop using the Service at any time, and may ask us to close your account
        and delete your data (see the <Link to="/privacy">Privacy Policy</Link>). We may
        suspend or close an account that breaches these Terms, or that we reasonably
        believe is being used to harm the Service or another person.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These Terms are governed by the laws of India, and the courts of India have
        exclusive jurisdiction over any dispute arising from them or from the Service.
      </p>

      <h2>13. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. The date at the top of this page
        changes when we do. If a change is material, we will make that clear on the
        Service. Continuing to use the Service after a change means you accept the
        updated Terms.
      </p>

      <h2>14. Contact</h2>
      <p className={styles.contact}>
        Questions about these Terms, or a notice about content:{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </LegalPage>
  )
}
