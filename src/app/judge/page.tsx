import { notFound } from "next/navigation";
import { JudgeApp } from "@/components/judge/JudgeApp";
import { isJudgeMode } from "@/lib/judge/judgePolicy";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Adrift preview",
  robots: { index: false, follow: false },
};

/** Judge studio; only exists when ADRIFT_JUDGE_MODE=1 (else 404). */
export default function JudgePage() {
  if (!isJudgeMode()) notFound();
  return <JudgeApp />;
}
