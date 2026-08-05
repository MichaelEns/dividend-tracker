/*
 * Which accounts count toward spendable dividend income.
 *
 * A brokerage login exposes far more than a taxable brokerage account. One
 * real Fidelity consent returned a 401(k), deferred compensation, a traditional
 * IRA, a Roth IRA, an ESPP, an HSA, an individual account, cash management and
 * a credit card - nine accounts, of which three hold spendable positions.
 *
 * Summing all of them answers the wrong question. A dividend paid inside a Roth
 * IRA or an HSA is reinvested behind a tax wrapper: it is real money, but it
 * does not arrive anywhere it can be spent, and it cannot be withdrawn without
 * a penalty or a taxable event. For a page whose whole purpose is "when does
 * money hit my account", counting it overstates the answer.
 *
 * So the rule is not "is this an investment account" but "can a dividend paid
 * here be spent when it lands". Shared by both providers because both have the
 * problem: Plaid's /investments/holdings/get aggregates across every account
 * behind the Item, retirement included.
 *
 * FAIL OPEN, DELIBERATELY
 * -----------------------
 * An account is only excluded when it is positively identified as sheltered.
 * An unrecognised type is kept, because a brokerage this code has never seen
 * would otherwise vanish silently and the user would simply be short some
 * shares with nothing on screen to explain it. Over-counting is visible - the
 * account is listed and can be removed; under-counting is not.
 */

/**
 * Normalised type codes for accounts whose dividends are not freely spendable.
 *
 * Matched exactly against an uppercased, punctuation-stripped type code, so
 * "401(k)" and "401K" are the same entry and no substring can accidentally
 * match inside an unrelated word.
 */
const SHELTERED_TYPES = new Set([
  // United States
  "401A", "401K", "403B", "457B", "ROTH", "ROTHIRA", "ROTH401K", "ROTH403B",
  "IRA", "TRADITIONALIRA", "ROLLOVERIRA", "SEPIRA", "SIMPLEIRA", "KEOGH",
  "HSA", "HEALTHSAVINGSACCOUNT", "PENSION", "TSP", "THRIFTSAVINGSPLAN",
  "PROFITSHARINGPLAN", "RETIREMENT", "529", "ESA", "EDUCATIONSAVINGSACCOUNT",
  // Fidelity reports non-qualified deferred compensation as NONP. The money is
  // deferred by definition - that is the entire point of the plan.
  "NONP", "DEFERREDCOMPENSATION",
  // Canada
  "RRSP", "TFSA", "RESP", "RRIF", "LIRA", "LIF", "LRIF", "LRSP", "PRIF", "FHSA",
  // United Kingdom
  "SIPP",
]);

/**
 * Phrases that identify a sheltered account by name.
 *
 * A second signal because `raw_type` is whatever the brokerage chose to send:
 * Fidelity returns clean codes like ROTH and HSA, but also free text like
 * "Fidelity Credit Card". Word boundaries matter - a bare substring test for
 * "ira" matches "spiral".
 */
const SHELTERED_NAME =
  /(\b401\s*\(?k\)?|\b403\s*\(?b\)?|\b457\b|\broth\b|\bira\b|\bhsa\b|health\s+savings|\bpension\b|deferred\s+comp|\bretirement\b|\brrsp\b|\btfsa\b|\bresp\b|\bsipp\b|\b529\b)/i;

/** Uppercase, strip everything that is not a letter or a digit. */
function normalizeType(value) {
  return String(value == null ? "" : value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * Classify an account.
 *
 * Returns one of:
 *   "spendable"  - dividends here can be spent when they land
 *   "sheltered"  - a retirement, health or education wrapper
 *   "credit"     - a card or line of credit; a liability, never a holding
 *   "deposit"    - chequing or savings; no positions to read
 *
 * `category` is a provider-normalised bucket when one exists (SnapTrade's
 * account_category, Plaid's account type). `type` is the provider's own code.
 */
function classifyAccount({ category, type, name } = {}) {
  const cat = normalizeType(category);
  const code = normalizeType(type);
  const label = String(name == null ? "" : name);

  // A credit card is never a holding, whatever else it looks like. Checked
  // first because a card can be named anything at all.
  if (cat === "LOC" || cat === "CREDIT" || code === "CREDITCARD" || code === "CREDIT"
    || /credit\s*card|\bvisa\b|mastercard|line\s+of\s+credit/i.test(label)) {
    return "credit";
  }
  if (cat === "DEPOSIT" || cat === "DEPOSITORY" || code === "CHECKING"
    || code === "CHEQUING" || code === "SAVINGS") {
    return "deposit";
  }
  if (SHELTERED_TYPES.has(code) || SHELTERED_NAME.test(label)) return "sheltered";
  return "spendable";
}

/** True when a dividend paid into this account could be spent on arrival. */
function isSpendableAccount(account) {
  return classifyAccount(account) === "spendable";
}

export {
  SHELTERED_TYPES,
  SHELTERED_NAME,
  normalizeType,
  classifyAccount,
  isSpendableAccount,
};
