import facts from '../data/facts.json';

/**
 * Read-only access to the verified local knowledge base (src/data/facts.json).
 *
 * This is the single source of truth for factual content in the app - the
 * language model is never allowed to invent facts, only restyle whatever
 * this class returns. Each vegetable maps to several verified facts;
 * getFact() picks one at random on every call, avoiding an immediate repeat
 * of whichever fact it returned last for that same vegetable.
 */
export class FactsRepository {
  constructor(factsData = facts) {
    // Indexed by lowercase label so a casing mismatch (metadata.json's
    // labels are capitalized except for "eggplant") never causes a missed
    // lookup between the classifier's output and the knowledge base.
    this.factsByLowercaseLabel = Object.fromEntries(
      Object.entries(factsData).map(([label, factList]) => [label.toLowerCase(), factList]),
    );

    // Remembers which fact index was returned last per label, so the very
    // next pick for that same vegetable can skip it.
    this.lastIndexByLowercaseLabel = {};
  }

  /**
   * Returns a verified fact for a label, or null if the label has none.
   * Picks randomly among that label's facts; if there's more than one, the
   * fact just returned for that label is never picked twice in a row.
   */
  getFact(vegetableLabel) {
    if (!vegetableLabel) return null;

    const key = vegetableLabel.toLowerCase();
    const factList = this.factsByLowercaseLabel[key];
    if (!factList || factList.length === 0) return null;
    if (factList.length === 1) return factList[0];

    const lastIndex = this.lastIndexByLowercaseLabel[key];
    let nextIndex = lastIndex;
    while (nextIndex === lastIndex) {
      nextIndex = Math.floor(Math.random() * factList.length);
    }

    this.lastIndexByLowercaseLabel[key] = nextIndex;
    return factList[nextIndex];
  }

  /** True if the knowledge base has at least one fact for this label. */
  hasFact(vegetableLabel) {
    if (!vegetableLabel) return false;
    const factList = this.factsByLowercaseLabel[vegetableLabel.toLowerCase()];
    return Array.isArray(factList) && factList.length > 0;
  }
}
