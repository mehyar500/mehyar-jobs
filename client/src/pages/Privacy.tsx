export default function Privacy() {
  return (
    <div className="legal col" style={{ gap: 8, paddingBottom: 48 }}>
      <h1>Privacy Policy</h1>
      <p className="sm muted">Last updated: September 13, 2026</p>

      <h2>1. What we collect</h2>
      <ul className="review-list">
        <li><strong>Account info:</strong> email address, display name, and a salted hash of your password (we never store your actual password).</li>
        <li><strong>Your resume:</strong> the text you paste or upload, plus the profile we derive from it (target titles, keywords, locations).</li>
        <li><strong>Your activity:</strong> match scores we compute for you, digest delivery records, and your newsletter preference.</li>
        <li><strong>Technical:</strong> a login token stored in your browser's local storage so you stay signed in.</li>
        <li><strong>Free-check allowance:</strong> if you use the free resume check without an account, we store a salted one-way hash of your IP address — just enough to know you've used your one free check. We never store the raw IP for this purpose.</li>
      </ul>

      <h2>2. What we do with it</h2>
      <ul className="review-list">
        <li>Score job postings against your resume and show you ranked matches.</li>
        <li>Send you digest emails about new matches — <strong>only if you opted in</strong> via the separate, optional newsletter checkbox on signup (unchecked by default). You can opt out any time.</li>
        <li>Run optional AI resume reviews when you ask for one.</li>
        <li>Keep the service running and prevent abuse.</li>
      </ul>

      <h2>3. What we never do</h2>
      <ul className="review-list">
        <li><strong>We never sell your data.</strong> Not your email, not your resume, not anything.</li>
        <li>We never share your resume with employers or third parties.</li>
        <li>We never send your info to advertisers.</li>
      </ul>

      <h2>4. Who processes your data</h2>
      <p>
        The service runs on Cloudflare (hosting, database, and email delivery). Your data lives in our
        Cloudflare D1 database and is transmitted over encrypted connections. AI resume reviews are processed
        by Cloudflare's Workers AI; your resume text is sent to the model only when you request a review.
      </p>

      <h2>5. Emails and unsubscribing</h2>
      <p>
        Digest emails go only to members who opted into the newsletter. Every email has a one-click
        unsubscribe link that works without logging in, and you can toggle the newsletter off in your account
        or on the <strong>/unsubscribe</strong> page. Unsubscribing stops all marketing/digest email immediately —
        your account and matches stay intact.
      </p>

      <h2>6. Your control</h2>
      <ul className="review-list">
        <li>Update or replace your resume any time from the Run page.</li>
        <li>Turn the newsletter off any time (account toggle or one-click unsubscribe link).</li>
        <li>Ask us to delete your account and data: email <strong>info@mehyar.us</strong> from your account email and we'll remove it.</li>
      </ul>

      <h2>7. Data retention</h2>
      <p>
        We keep your account data while your account exists. If you ask for deletion, we remove your account,
        resumes, profiles, match scores, and digest logs.
      </p>

      <h2>8. Changes</h2>
      <p>
        We'll update this page if our practices change, and note the new "last updated" date above.
      </p>

      <h2>9. Contact</h2>
      <p>Privacy questions or deletion requests: <strong>info@mehyar.us</strong>.</p>
    </div>
  );
}
