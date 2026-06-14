// Small, dependency-free validators used by the auth controller.
// Keeping validation here keeps controllers readable and rules reusable.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalize an email before storing/comparing: trim + lowercase.
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}

// Returns an error string if the password is weak, otherwise null.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (password.length > 128) {
    return 'Password is too long';
  }
  return null;
}

// Basic phone sanity check (optional field). Allows +, digits, spaces, dashes.
function isValidPhone(phone) {
  if (phone == null || phone === '') return true; // optional
  return typeof phone === 'string' && /^[+]?[\d\s-]{7,15}$/.test(phone.trim());
}

// Login uses ONE field that can be either an email or a phone number.
// If it looks like an email we lowercase it (emails are stored lowercase);
// otherwise we keep it trimmed as-is (phone). The value is still always
// passed to the DB as a parameter, never concatenated into SQL.
function normalizeIdentifier(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return isValidEmail(v) ? v.toLowerCase() : v;
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  validatePassword,
  isValidPhone,
  normalizeIdentifier
};