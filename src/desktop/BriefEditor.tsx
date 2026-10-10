import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { Field } from "../ui/Field";
import { GrowingTextarea } from "../ui/GrowingTextarea";
import { Button, IconButton } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import type {
  Brief,
  BriefField,
  BriefListField,
  DraftEdit,
} from "../application/contracts/drafting";
import type { MissionDefinition } from "../application/contracts/node";
import { briefLabels } from "../../shared/mission-draft.mjs";

function BriefList({
  field,
  values,
  edit,
  placeholder,
  highlighted,
  addition,
}: {
  field: BriefListField;
  values: string[];
  edit: (changes: DraftEdit) => void;
  placeholder: string;
  highlighted: boolean;
  addition: string;
}) {
  const input = useRef(addition);
  input.current = addition;
  const limit = field === "criteria" ? 32 : 16;
  const add = () => {
    if (input.current.trim() && values.length < limit) {
      const value = input.current.trim();
      input.current = "";
      edit({ [field]: [...values, value], listInputs: { [field]: "" } });
    }
  };
  return (
    <section
      className={`md-list ${highlighted ? "md-changed" : ""}`}
      aria-label={briefLabels[field]}
    >
      <h3>
        {briefLabels[field]}{" "}
        {highlighted ? (
          <span className="md-change-label">Updated by your helper</span>
        ) : null}
      </h3>
      {values.map((value, i) => (
        <div className="md-list-row" key={i}>
          <span className="d-mono" aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          <GrowingTextarea
            rows={2}
            aria-label={`${briefLabels[field]} ${i + 1}`}
            value={value}
            maxLength={1024}
            onChange={(e) =>
              edit({
                [field]: values.map((x, n) => (n === i ? e.target.value : x)),
              })
            }
          />
          <IconButton
            aria-label={`Remove ${briefLabels[field].toLowerCase()} ${i + 1}`}
            onClick={() => edit({ [field]: values.filter((_, n) => n !== i) })}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <div className="n-inline">
        <input
          aria-label={`Add to ${briefLabels[field].toLowerCase()}`}
          value={addition}
          placeholder={placeholder}
          maxLength={1024}
          disabled={values.length >= limit}
          onChange={(e) => edit({ listInputs: { [field]: e.target.value } })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <IconButton
          aria-label={`Add ${briefLabels[field].toLowerCase()}`}
          disabled={!addition.trim() || values.length >= limit}
          onClick={add}
        >
          <Plus size={16} />
        </IconButton>
      </div>
    </section>
  );
}
export function BriefEditor({
  brief,
  edit,
  changed,
  disabled,
  listInputs,
}: {
  brief: Brief;
  edit: (changes: DraftEdit) => void;
  changed: BriefField[];
  disabled: boolean;
  listInputs: Record<BriefListField, string>;
}) {
  return (
    <fieldset className="n-fields md-brief-fields" disabled={disabled}>
      {(
        [
          ["name", "A short, recognizable name", 120, 1],
          ["objective", "What should this mission accomplish?", 4096, 3],
          [
            "scope",
            "What is in, what is out, and what may the team change?",
            8192,
            3,
          ],
        ] as const
      ).map(([key, placeholder, max, rows]) => (
        <Field key={key} className={changed.includes(key) ? "md-changed" : ""}>
          <span>
            {briefLabels[key]}{" "}
            {changed.includes(key) ? (
              <span className="md-change-label">Updated by your helper</span>
            ) : null}
          </span>
          {key === "name" ? (
            <input
              name="name"
              value={brief.name}
              maxLength={max}
              onChange={(e) => edit({ name: e.target.value })}
              placeholder={placeholder}
            />
          ) : (
            <GrowingTextarea
              name={key}
              rows={rows}
              value={brief[key]}
              maxLength={max}
              onChange={(e) => edit({ [key]: e.target.value })}
              placeholder={placeholder}
            />
          )}
        </Field>
      ))}
      <BriefList
        field="deliverables"
        addition={listInputs.deliverables}
        values={brief.deliverables}
        edit={edit}
        placeholder="What should you receive?"
        highlighted={changed.includes("deliverables")}
      />
      <BriefList
        field="criteria"
        addition={listInputs.criteria}
        values={brief.criteria}
        edit={edit}
        placeholder="How will you judge the result?"
        highlighted={changed.includes("criteria")}
      />
      {brief.assumptions.length > 0 || brief.openQuestions.length > 0 ? (
        <div className="md-decisions">
          <p className="d-field-help">
            These are proposals, not agreed facts. Edit or remove them before
            review.
          </p>
          <BriefList
            field="assumptions"
            addition={listInputs.assumptions}
            values={brief.assumptions}
            edit={edit}
            placeholder="Add a working assumption"
            highlighted={changed.includes("assumptions")}
          />
          <BriefList
            field="openQuestions"
            addition={listInputs.openQuestions}
            values={brief.openQuestions}
            edit={edit}
            placeholder="Leave a question for the team"
            highlighted={changed.includes("openQuestions")}
          />
        </div>
      ) : (
        <Disclosure title="Assumptions and questions for the team">
          <BriefList
            field="assumptions"
            addition={listInputs.assumptions}
            values={brief.assumptions}
            edit={edit}
            placeholder="Add a working assumption"
            highlighted={false}
          />
          <BriefList
            field="openQuestions"
            addition={listInputs.openQuestions}
            values={brief.openQuestions}
            edit={edit}
            placeholder="Let the team investigate…"
            highlighted={false}
          />
        </Disclosure>
      )}
    </fieldset>
  );
}
export function DraftSettings({
  policy,
  edit,
  disabled,
}: {
  policy: MissionDefinition["policy"];
  edit: (changes: DraftEdit) => void;
  disabled: boolean;
}) {
  const budget = policy?.budget ?? { mode: "unlimited" as const };
  if (!policy) return null;
  const limited = budget.mode === "limited";
  const changeBudget = (changes: object) =>
    edit({ policy: { ...policy, budget: { ...budget, ...changes } } });
  return (
    <Disclosure
      title={`Mission settings · ${policy.coordination === "peer" ? "Peer collaboration" : "Coordinator-led"} · ${policy.participation === "approval" ? "Approval required" : "Private"} · ${limited ? "Limited" : "Unlimited"} budget`}
    >
      <fieldset className="n-fields" disabled={disabled}>
        <div className="d-two-columns">
          <Field>
            Coordination
            <select
              value={policy.coordination}
              onChange={(e) =>
                edit({
                  policy: {
                    ...policy,
                    coordination: e.target.value as "peer" | "coordinated",
                  },
                })
              }
            >
              <option value="coordinated">Coordinator-led</option>
              <option value="peer">Peer collaboration</option>
            </select>
          </Field>
          <Field>
            Participation
            <select
              name="participation"
              value={policy.participation}
              onChange={(e) =>
                edit({
                  policy: {
                    ...policy,
                    participation: e.target.value as "private" | "approval",
                  },
                })
              }
            >
              <option value="private">Private invitation</option>
              <option value="approval">Discoverable · approval required</option>
            </select>
            <span className="d-field-help">
              Discoverable missions remain unlisted until you publish a public
              brief.
            </span>
          </Field>
        </div>
        <Field>
          Mission budget
          <select
            value={budget.mode}
            onChange={(e) =>
              edit({
                policy: {
                  ...policy,
                  budget:
                    e.target.value === "unlimited"
                      ? { mode: "unlimited" }
                      : {
                          mode: "limited",
                          turns: 100,
                          concurrency: null,
                          deadline_ms: null,
                          tokens: null,
                          model_cost_microusd: null,
                        },
                },
              })
            }
          >
            <option value="unlimited">No budget · Unlimited</option>
            <option value="limited">Set limits</option>
          </select>
        </Field>
        {budget.mode === "limited" ? (
          <div className="d-two-columns">
            <Field>
              Turns
              <input
                type="number"
                min={1}
                max={4294967295}
                value={budget.turns ?? ""}
                onChange={(e) =>
                  changeBudget({
                    turns: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </Field>
            <Field>
              Concurrent turns
              <input
                type="number"
                min={1}
                max={1024}
                value={budget.concurrency ?? ""}
                placeholder="No cap"
                onChange={(e) =>
                  changeBudget({
                    concurrency: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </Field>
            <Field>
              Deadline
              <input
                type="datetime-local"
                value={
                  budget.deadline_ms
                    ? new Date(
                        budget.deadline_ms -
                          new Date(budget.deadline_ms).getTimezoneOffset() *
                            60000,
                      )
                        .toISOString()
                        .slice(0, 16)
                    : ""
                }
                onChange={(e) =>
                  changeBudget({
                    deadline_ms: e.target.value
                      ? new Date(e.target.value).getTime()
                      : null,
                  })
                }
              />
            </Field>
          </div>
        ) : (
          <p className="d-field-help">
            Your provider’s subscription limits still apply. Local execution
            consent stays separate.
          </p>
        )}
      </fieldset>
    </Disclosure>
  );
}
