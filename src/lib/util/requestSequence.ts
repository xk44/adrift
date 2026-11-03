export interface RequestTicket {
  readonly id: number;
  readonly signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface RequestSequence {
  begin: () => RequestTicket;
  cancel: () => void;
  isCurrent: (ticket: RequestTicket) => boolean;
}

export function createRequestSequence(): RequestSequence {
  let latestId = 0;
  let activeController: AbortController | null = null;

  return {
    begin: () => {
      activeController?.abort();
      const controller = new AbortController();
      const id = ++latestId;
      activeController = controller;

      return {
        id,
        signal: controller.signal,
        isCurrent: () =>
          id === latestId &&
          activeController === controller &&
          !controller.signal.aborted,
      };
    },
    cancel: () => {
      activeController?.abort();
      activeController = null;
      latestId += 1;
    },
    isCurrent: (ticket) => ticket.isCurrent(),
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
