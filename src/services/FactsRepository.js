import facts from '../data/facts.json';

/**
 * Read-only access to the verified local knowledge base (src/data/facts.json).
 *
 * This is the single source of truth for factual content in the app - the
 * language model is never allowed to invent facts, only restyle whatever
 * this class returns.
 */
export class FactsRepository {
  constructor(factsData = facts) {
    // Indexed by lowercase label so a casing mismatch (metadata.json's
    // labels are capitalized except for "eggplant") never causes a missed
    // lookup between the classifier's output and the knowledge base.
    this.factsByLowercaseLabel = Object.fromEntries(
      Object.entries(factsData).map(([label, fact]) => [label.toLowerCase(), fact]),
    );
  }

  /** Returns the verified fact for a label, or null if none exists. */
  getFact(vegetableLabel) {
    if (!vegetableLabel) return null;
    return this.factsByLowercaseLabel[vegetableLabel.toLowerCase()] ?? null;
  }

  /** True if the knowledge base has an entry for this label. */
  hasFact(vegetableLabel) {
    return this.getFact(vegetableLabel) !== null;
  }
}
