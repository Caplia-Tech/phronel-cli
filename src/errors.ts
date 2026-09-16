// Stable exit codes. Agents branch on these; never renumber.
export const EXIT_OK = 0;
export const EXIT_API = 1; // the API returned an error
export const EXIT_USAGE = 2; // bad arguments or flags
export const EXIT_AUTH = 3; // missing key, invalid key, or insufficient scope
export const EXIT_NETWORK = 4; // could not reach the API, or timed out

export interface CliErrorOpts {
  code: string;
  exitCode: number;
  fix?: string;
  requestId?: string;
  status?: number;
}

export class CliError extends Error {
  code: string;
  exitCode: number;
  fix?: string;
  requestId?: string;
  status?: number;

  constructor(message: string, opts: CliErrorOpts) {
    super(message);
    this.code = opts.code;
    this.exitCode = opts.exitCode;
    this.fix = opts.fix;
    this.requestId = opts.requestId;
    this.status = opts.status;
  }
}
