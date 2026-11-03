/**
 * ComfyUI clientId, one per browser tab.
 *
 * ComfyUI routes a prompt's progress/executed events to the socket that
 * registered its client_id; two sockets with the same id race for them and
 * one side never sees its job finish. The id therefore lives in
 * sessionStorage (per tab, survives reloads) instead of the persisted store
 * (localStorage, shared by every tab).
 *
 * Duplicating a tab copies sessionStorage, so the copy starts with the same
 * id. guardTabClientId() announces the id over a BroadcastChannel; a tab
 * that hears its own id from an existing tab picks a new one.
 */

export const TAB_CLIENT_ID_KEY = "adrift.comfyClientId";
const CHANNEL_NAME = "adrift-comfy-client-id";

type KV = Pick<Storage, "getItem" | "setItem">;

function sessionStore(): KV | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function newId(): string {
  return crypto.randomUUID();
}

/** This tab's clientId, created on first use. */
export function getTabClientId(storage: KV | null = sessionStore()): string {
  try {
    const existing = storage?.getItem(TAB_CLIENT_ID_KEY);
    if (existing) return existing;
  } catch {
    // Storage blocked: fall through to an in-memory id.
  }
  const id = newId();
  setTabClientId(id, storage);
  return id;
}

export function setTabClientId(
  id: string,
  storage: KV | null = sessionStore(),
): void {
  try {
    storage?.setItem(TAB_CLIENT_ID_KEY, id);
  } catch {
    // ignore
  }
}

type GuardMessage =
  | { type: "hello"; id: string; from: string }
  | { type: "taken"; id: string; to: string };

interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

// One nonce per tab (module instance), not per guard: two guards in the same
// tab (a second hook instance) must never treat each other as a duplicate.
const TAB_NONCE = newId();

/**
 * Detect another tab using the same clientId. `getId` reads the current id;
 * `onCollision` must switch this tab to a fresh one. Returns a stop function.
 */
export function guardTabClientId(
  getId: () => string,
  onCollision: () => void,
  createChannel: (name: string) => ChannelLike | null = (name) =>
    typeof BroadcastChannel === "undefined"
      ? null
      : (new BroadcastChannel(name) as unknown as ChannelLike),
  nonce: string = TAB_NONCE,
): () => void {
  const channel = createChannel(CHANNEL_NAME);
  if (!channel) return () => {};

  channel.onmessage = (event) => {
    const msg = event.data as GuardMessage | null;
    if (!msg || typeof msg !== "object") return;
    const mine = getId();
    if (msg.id !== mine) return;
    if (msg.type === "hello" && msg.from !== nonce) {
      // Someone else announced our id: tell them to move.
      channel.postMessage({ type: "taken", id: mine, to: msg.from });
    } else if (msg.type === "taken" && msg.to === nonce) {
      onCollision();
    }
  };
  channel.postMessage({ type: "hello", id: getId(), from: nonce });

  return () => {
    channel.onmessage = null;
    channel.close();
  };
}
