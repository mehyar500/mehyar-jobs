// _shared/atsStrategies.js
//
// Per-ATS form-filling strategies. The general auto-submit fills
// single-page forms. Workday, Ashby, and Greenhouse have multi-step
// wizards. This file declares the per-ATS page-detection + step
// order so the headless run can navigate them.

export const ATS_STRATEGIES = {
  workday: {
    name: "Workday",
    // Workday forms are: /job/<location>/<title>_<id>  →  /apply
    // The apply step is 5-7 pages: account → resume → questions → EEO → review → submit
    steps: [
      { name: "open_apply",            selector: "a[href*='/apply'], button:has-text('Apply'), a[data-automation-id='applyButton']" },
      { name: "create_account_or_login", selector: "input[type='email'], input[name='email']" },
      { name: "upload_resume",         selector: "input[type='file']" },
      { name: "fill_questions",        selector: "[data-automation-id='formField'] input, [data-automation-id='formField'] textarea" },
      { name: "eeo_voluntary",         selector: "[data-automation-id='formField']" },
      { name: "review_and_submit",     selector: "button:has-text('Submit'), [data-automation-id='bottom-navigation-next-button']" },
    ],
    // Workday uses a "Next" button to advance; the final page has "Submit"
    advanceButton: "[data-automation-id='bottom-navigation-next-button']",
    submitButton: "button:has-text('Submit Application')",
    knownFields: {
      "First Name":       "profile.first_name",
      "Last Name":        "profile.last_name",
      "Email":            "profile.email",
      "Phone":            "profile.phone",
      "Address":          "profile.cleartext_address",
      "How did you hear": "profile.default_answers.how_did_you_hear",
      "Years of experience": "profile.years_experience",
    },
  },
  ashby: {
    name: "Ashby",
    // Ashby forms are single-page but have a multi-section layout.
    // Detect the "Application" tab; fill name/email/phone/LinkedIn;
    // upload resume; answer any custom questions; submit.
    steps: [
      { name: "fill_basics",        selector: "input[name='firstName'], input[name='lastName'], input[type='email']" },
      { name: "upload_resume",     selector: "input[type='file']" },
      { name: "fill_profile_urls", selector: "input[name='linkedIn'], input[name='website'], input[name='github']" },
      { name: "fill_questions",    selector: "[data-question-id], textarea, input[type='text']:not([name='firstName']):not([name='lastName']):not([type='email'])" },
      { name: "submit",            selector: "button[type='submit'], button:has-text('Submit Application')" },
    ],
    submitButton: "button:has-text('Submit Application')",
    knownFields: {
      "First Name":       "profile.first_name",
      "Last Name":        "profile.last_name",
      "Email":            "profile.email",
      "Phone":            "profile.phone",
      "LinkedIn":         "profile.linkedin_url",
      "GitHub":           "profile.github_url",
      "Website":          "profile.personal_website",
    },
  },
  greenhouse: {
    name: "Greenhouse",
    // Greenhouse has a custom-questions step. We POST a structured
    // form via the public "Application Submit" endpoint:
    //   POST https://boards-api.greenhouse.io/v1/boards/{handle}/jobs/{id}
    //
    // Most companies use Greenhouse Job Board API which has a public
    // form-submit endpoint. For one-click apply we POST a JSON body
    // to it directly. If the form has custom questions, we send
    // answers from the user's profile + LLM-filled.
    steps: [
      { name: "open_apply",   selector: "a[href*='/apply']" },
      { name: "fill_basics",  selector: "#first_name, #last_name, input[type='email']" },
      { name: "upload_resume", selector: "input[type='file'][name='resume']" },
      { name: "fill_questions", selector: ".field[data-field-id], textarea[name*='question']" },
      { name: "submit",       selector: "input[type='submit'], button[type='submit']" },
    ],
    submitButton: "#submit_app",
    knownFields: {
      "first_name": "profile.first_name",
      "last_name":  "profile.last_name",
      "email":      "profile.email",
      "phone":      "profile.phone",
    },
  },
  lever: {
    name: "Lever",
    steps: [
      { name: "open_apply",   selector: "a.posting-btn" },
      { name: "fill_basics",  selector: "input[name='name'], input[type='email'], input[name='phone']" },
      { name: "upload_resume", selector: "input[type='file']" },
      { name: "fill_questions", selector: ".application-field input, .application-field textarea" },
      { name: "submit",       selector: "button.template-btn-submit" },
    ],
    submitButton: "button.template-btn-submit",
    knownFields: {
      "name":  "profile.full_name",
      "email": "profile.email",
      "phone": "profile.phone",
    },
  },
  smartrecruiters: {
    name: "SmartRecruiters",
    steps: [
      { name: "open_apply",   selector: "a:has-text('Apply')" },
      { name: "fill_basics",  selector: "input[name='firstName'], input[name='lastName'], input[type='email']" },
      { name: "upload_resume", selector: "input[type='file']" },
      { name: "fill_questions", selector: "[data-test='field'] input, [data-test='field'] textarea" },
      { name: "submit",       selector: "button:has-text('Submit')" },
    ],
    submitButton: "button:has-text('Submit')",
    knownFields: {
      "firstName": "profile.first_name",
      "lastName":  "profile.last_name",
      "email":     "profile.email",
    },
  },
  html: {
    name: "Generic HTML form",
    steps: [
      { name: "fill_basics",  selector: "input[name*='name'], input[name*='email'], input[name*='phone']" },
      { name: "upload_resume", selector: "input[type='file']" },
      { name: "fill_questions", selector: "input, textarea, select" },
      { name: "submit",       selector: "button[type='submit'], input[type='submit']" },
    ],
    submitButton: "button[type='submit'], input[type='submit']",
  },
};

export function detectATS(jobUrl) {
  if (!jobUrl) return "html";
  const u = jobUrl.toLowerCase();
  if (u.includes("myworkdayjobs")) return "workday";
  if (u.includes("ashbyhq")) return "ashby";
  if (u.includes("greenhouse")) return "greenhouse";
  if (u.includes("lever.co") || u.includes("lever")) return "lever";
  if (u.includes("smartrecruiters")) return "smartrecruiters";
  return "html";
}
