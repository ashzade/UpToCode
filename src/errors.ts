export class ParseError extends Error {
  constructor(message: string, public line?: number, public section?: string) {
    super(line ? `[Line ${line}] ${section ? `[${section}] ` : ''}${message}` : message);
    this.name = 'ParseError';
  }
}
