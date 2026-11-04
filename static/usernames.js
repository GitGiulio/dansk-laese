const domain = 'usernames.danskreader.invalid';

export const normalizeUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function validateUsername(value) {
  return /^[a-z0-9_]{3,24}$/.test(normalizeUsername(value)) ? '' : 'Use a username of 3-24 letters, numbers, or underscores.';
}

export function usernameEmail(value) {
  const error = validateUsername(value);
  if (error) throw new Error(error);
  return `${normalizeUsername(value)}@${domain}`;
}

export function usernameFromEmail(value) {
  if (typeof value !== 'string') return null;
  const [name,host,extra] = value.toLowerCase().split('@');
  return extra === undefined && host === domain && !validateUsername(name) ? name : null;
}

export function suggestUsernames(value) {
  if (validateUsername(value)) return [];
  const name = normalizeUsername(value);
  return ['1','2','3','4'].map(suffix => name.slice(0,24-suffix.length) + suffix).filter(candidate => candidate !== name).slice(0,3);
}
