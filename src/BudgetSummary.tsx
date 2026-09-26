import type { Budget } from "./resources";
import { hasBudgetLimits } from "./resources";
const amount = (_key: string, value: number | null) =>
  value === null
    ? "No limit"
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
export function BudgetSummary({
  budget,
  open,
}: {
  budget: Budget;
  open: () => void;
}) {
  const limited = hasBudgetLimits(budget.limits);
  const label = budget.deadlineReached
    ? "Deadline reached"
    : budget.exhausted
      ? "Budget exhausted"
      : !limited
        ? "Unlimited"
        : budget.limits.turns !== null
          ? `${budget.available.turns} turns remaining`
          : budget.limits.costUsd !== null
            ? `${amount("costUsd", budget.available.costUsd)} available`
            : budget.limits.tokens !== null
              ? `${budget.available.tokens?.toLocaleString()} tokens available`
              : budget.limits.concurrency !== null
                ? `${budget.active}/${budget.limits.concurrency} running`
                : `${budget.active} running`;
  return (
    <button
      className="button budget-summary"
      onClick={open}
      title="View mission budget"
    >
      <i className={`square ${budget.exhausted ? "warning" : "muted"}`} />
      <span>Budget · {label}</span>
    </button>
  );
}
