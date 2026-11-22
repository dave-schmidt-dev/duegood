const SIGN_IN_REASONS = new Set([
  "CREDENTIALS_UNAVAILABLE",
  "SIGN_IN_BLOCKED",
  "VERIFICATION_REQUIRED",
  "SURVEY_POPUP_BLOCKING",
  "UNKNOWN_PAGE",
  "SIGN_IN_TIMEOUT",
  "SIGN_IN_REQUIRED",
]);

const OUTCOME_REASONS = new Map([
  ["CREDENTIALS_UNAVAILABLE", "CREDENTIALS_UNAVAILABLE"],
  ["BLOCKED_AFTER_REJECTION", "SIGN_IN_BLOCKED"],
  ["CREDENTIALS_REJECTED", "SIGN_IN_BLOCKED"],
  ["PUSH_OR_NUMBER_CHALLENGE", "VERIFICATION_REQUIRED"],
  ["FASTPASS_CHALLENGE", "VERIFICATION_REQUIRED"],
  ["ENROLLMENT_REQUIRED", "VERIFICATION_REQUIRED"],
  ["CAPTCHA_REQUIRED", "VERIFICATION_REQUIRED"],
  ["UNSUPPORTED_AUTHENTICATOR", "VERIFICATION_REQUIRED"],
  ["AUTHENTICATOR_UNAVAILABLE", "VERIFICATION_REQUIRED"],
  ["PASSCODE_UNAVAILABLE", "VERIFICATION_REQUIRED"],
  ["UNKNOWN_PAGE", "UNKNOWN_PAGE"],
  ["STEP_TIMEOUT", "SIGN_IN_TIMEOUT"],
  ["STEP_LIMIT_EXCEEDED", "SIGN_IN_TIMEOUT"],
  ["NOT_ON_OKTA", "SIGN_IN_REQUIRED"],
  ["SIGNED_IN", "SIGN_IN_REQUIRED"],
  ["OKTA_HOST_REJECTED", "OKTA_HOST_REJECTED"],
]);

/** Return whether a reason is part of the content-free refresh protocol. */
export function isSignInReason(value) {
  return SIGN_IN_REASONS.has(value);
}

/** Map an internal sign-in outcome to its bounded public reason, when eligible. */
export function signInReasonForOutcome(outcome) {
  return OUTCOME_REASONS.get(outcome);
}

/** Parse broker flags, returning undefined when the argument list is invalid. */
export function parseSessionMode(args) {
  if (!Array.isArray(args) || args.length > 1) return undefined;
  if (args.length === 0 || args[0] === "--headless") return true;
  if (args[0] === "--headed") return false;
  return undefined;
}
