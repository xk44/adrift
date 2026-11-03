import { describe, expect, it } from "vitest";
import { withLock } from "@/lib/locks";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("withLock", () => {
  it("serializes callbacks for the same key", async () => {
    const firstRelease = deferred();
    const events: string[] = [];

    const first = withLock("same", async () => {
      events.push("first:start");
      await firstRelease.promise;
      events.push("first:end");
      return "first";
    });
    const second = withLock("same", async () => {
      events.push("second:start");
      return "second";
    });

    await tick();
    expect(events).toEqual(["first:start"]);

    firstRelease.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different keys to run concurrently", async () => {
    const release = deferred();
    const events: string[] = [];

    const first = withLock("one", async () => {
      events.push("one:start");
      await release.promise;
      return "one";
    });
    const second = withLock("two", async () => {
      events.push("two:start");
      await release.promise;
      return "two";
    });

    await tick();
    expect(events.sort()).toEqual(["one:start", "two:start"]);

    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
  });

  it("does not let rejection block the next caller", async () => {
    const events: string[] = [];

    const first = withLock("rejects", async () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = withLock("rejects", async () => {
      events.push("second");
      return "ok";
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first", "second"]);
  });
});
