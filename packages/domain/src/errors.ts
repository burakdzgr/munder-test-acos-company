/** Raised when a factory or guard rejects input that violates a domain invariant. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
