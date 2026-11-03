/**
 * Preference Store Tests
 * ======================
 * Teach mode votes, ranking votes, streak logic, session counting.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { usePreferenceStore } from "@/store/preferenceStore";

beforeEach(() => {
  usePreferenceStore.setState({
    votes: [],
    sessionCount: 0,
    currentSessionVotes: 0,
    rankingVotes: [],
    rankingStreak: 0,
    lastRankingDate: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("addVote (Teach mode)", () => {
  it("appends a vote with timestamp", () => {
    usePreferenceStore.getState().addVote({
      imageA: "img-1",
      imageB: "img-2",
      preferred: "a",
    });

    const { votes, currentSessionVotes } = usePreferenceStore.getState();
    expect(votes).toHaveLength(1);
    expect(votes[0].imageA).toBe("img-1");
    expect(votes[0].preferred).toBe("a");
    expect(votes[0].timestamp).toBeTypeOf("number");
    expect(currentSessionVotes).toBe(1);
  });

  it("increments currentSessionVotes on each vote", () => {
    const { addVote } = usePreferenceStore.getState();
    addVote({ imageA: "a", imageB: "b", preferred: "a" });
    addVote({ imageA: "c", imageB: "d", preferred: "b" });
    addVote({ imageA: "e", imageB: "f", preferred: "a" });

    expect(usePreferenceStore.getState().currentSessionVotes).toBe(3);
    expect(usePreferenceStore.getState().votes).toHaveLength(3);
  });

  it("preserves existing votes when adding new ones", () => {
    usePreferenceStore.setState({
      votes: [
        { imageA: "old-a", imageB: "old-b", preferred: "a", timestamp: 1 },
      ],
    });
    usePreferenceStore.getState().addVote({
      imageA: "new-a",
      imageB: "new-b",
      preferred: "b",
    });
    expect(usePreferenceStore.getState().votes).toHaveLength(2);
  });
});

describe("incrementSession / resetSessionVotes", () => {
  it("increments session count and resets current votes", () => {
    usePreferenceStore.getState().addVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    expect(usePreferenceStore.getState().currentSessionVotes).toBe(1);

    usePreferenceStore.getState().incrementSession();
    const state = usePreferenceStore.getState();
    expect(state.sessionCount).toBe(1);
    expect(state.currentSessionVotes).toBe(0);
  });

  it("resetSessionVotes zeroes counter without touching sessionCount", () => {
    usePreferenceStore.getState().addVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    usePreferenceStore.getState().incrementSession();
    usePreferenceStore.getState().addVote({
      imageA: "c",
      imageB: "d",
      preferred: "b",
    });
    usePreferenceStore.getState().resetSessionVotes();

    const state = usePreferenceStore.getState();
    expect(state.sessionCount).toBe(1);
    expect(state.currentSessionVotes).toBe(0);
  });
});

describe("addRankingVote", () => {
  it("appends a ranking vote with timestamp", () => {
    usePreferenceStore.getState().addRankingVote({
      imageA: "img-1",
      imageB: "img-2",
      preferred: "b",
      challengePrompt: "which is better?",
    });

    const { rankingVotes } = usePreferenceStore.getState();
    expect(rankingVotes).toHaveLength(1);
    expect(rankingVotes[0].preferred).toBe("b");
    expect(rankingVotes[0].challengePrompt).toBe("which is better?");
    expect(rankingVotes[0].timestamp).toBeTypeOf("number");
  });
});

describe("streak logic", () => {
  function setDate(dateStr: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(dateStr + "T12:00:00Z"));
  }

  it("first vote ever starts streak at 1", () => {
    setDate("2025-01-15");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });

    const state = usePreferenceStore.getState();
    expect(state.rankingStreak).toBe(1);
    expect(state.lastRankingDate).toBe("2025-01-15");
  });

  it("multiple votes on same day do not increment streak", () => {
    setDate("2025-01-15");
    const { addRankingVote } = usePreferenceStore.getState();
    addRankingVote({ imageA: "a", imageB: "b", preferred: "a" });
    addRankingVote({ imageA: "c", imageB: "d", preferred: "b" });
    addRankingVote({ imageA: "e", imageB: "f", preferred: "a" });

    expect(usePreferenceStore.getState().rankingStreak).toBe(1);
    expect(usePreferenceStore.getState().rankingVotes).toHaveLength(3);
  });

  it("consecutive day increments streak", () => {
    setDate("2025-01-15");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(1);

    setDate("2025-01-16");
    usePreferenceStore.getState().addRankingVote({
      imageA: "c",
      imageB: "d",
      preferred: "b",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(2);
  });

  it("skipping a day resets streak to 1", () => {
    setDate("2025-01-15");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });

    // Skip Jan 16, vote on Jan 17 — 2 days gap
    setDate("2025-01-17");
    usePreferenceStore.getState().addRankingVote({
      imageA: "c",
      imageB: "d",
      preferred: "b",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(1);
  });

  it("multi-day streak accumulates correctly", () => {
    for (let day = 1; day <= 5; day++) {
      setDate(`2025-01-${String(day).padStart(2, "0")}`);
      usePreferenceStore.getState().addRankingVote({
        imageA: `a${day}`,
        imageB: `b${day}`,
        preferred: "a",
      });
    }
    expect(usePreferenceStore.getState().rankingStreak).toBe(5);
  });

  it("streak resets after gap then starts new streak", () => {
    setDate("2025-01-01");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    setDate("2025-01-02");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(2);

    // Gap
    setDate("2025-01-10");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(1);

    // Continue
    setDate("2025-01-11");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(2);
  });

  it("handles null lastRankingDate (first vote scenario)", () => {
    expect(usePreferenceStore.getState().lastRankingDate).toBeNull();
    expect(usePreferenceStore.getState().rankingStreak).toBe(0);

    setDate("2025-06-01");
    usePreferenceStore.getState().addRankingVote({
      imageA: "a",
      imageB: "b",
      preferred: "a",
    });
    expect(usePreferenceStore.getState().rankingStreak).toBe(1);
  });
});
