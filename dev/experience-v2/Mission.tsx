import { useRef, useState, useEffect, useLayoutEffect } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  Hash,
  LockKeyhole,
  MessageSquare,
  Pause,
  Send,
  Users,
  X,
} from "lucide-react";
import type { Agent, Brief, Message, Phase } from "./model";
import { agentChannel, channelNames, channelPurposes } from "./model";
import {
  Avatar,
  Button,
  Details,
  IconButton,
  Modal,
  PreviewLink,
  Tag,
} from "./ui";

type Props = {
  route: string;
  navigate: (path: string) => void;
  brief: Brief;
  phase: Phase;
  agents: Agent[];
  messages: Message[];
  scrollPositions: Record<string, number>;
  send: (text: string, channel: string) => void;
  drafts: Record<string, string>;
  draft: (channel: string, value: string) => void;
  pause: () => void;
  review: () => void;
  invite: () => void;
  accepted: boolean;
  created: boolean;
  delayed: boolean;
  owner: boolean;
  changeBrief: (value: Brief) => void;
};
export function Mission(p: Props) {
  const section = p.route.split("/")[1] || "main";
  const conversation = !["work", "people", "brief"].includes(section);
  const [thread, setThread] = useState<Message | null>(null);
  const [profile, setProfile] = useState<Agent | null>(null);
  const [search, setSearch] = useState("");
  const privateChat = section.startsWith("dm-");
  const recipient = p.agents.find((a) => agentChannel(a) === section);
  const channelName =
    recipient?.name || channelNames[section] || "Conversation";
  const channelPurpose = privateChat
    ? `Private · hosted ${recipient?.owner === "You" ? "on your Mac" : `by ${recipient?.owner || "the contributor"}`}`
    : channelPurposes[section];
  const list = useRef<HTMLDivElement>(null);
  const previousSection = useRef<string | null>(null);
  const atEnd = useRef(true);
  const visible = p.messages.filter(
    (m) =>
      m.channel === section &&
      (!search ||
        `${m.author} ${m.text}`.toLowerCase().includes(search.toLowerCase())),
  );
  useEffect(() => {
    setThread(null);
    setProfile(null);
    setSearch("");
  }, [section]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) {
      previousSection.current = null;
      return;
    }
    if (previousSection.current !== section) {
      element.scrollTop = p.scrollPositions[section] ?? element.scrollHeight;
      previousSection.current = section;
    } else if (atEnd.current) {
      element.scrollTop = element.scrollHeight;
    }
    atEnd.current =
      element.scrollHeight - element.clientHeight - element.scrollTop < 40;
  }, [section, visible.length]);
  const value = p.drafts[section] || "";
  const threadCounts: Record<string, number> = { m4: 1 };
  for (const message of p.messages) {
    if (message.channel.startsWith("thread-")) {
      const root = message.channel.slice(7);
      threadCounts[root] = (threadCounts[root] || 0) + 1;
    }
  }
  const submit = () => {
    if (value.trim()) {
      atEnd.current = true;
      p.send(value, section);
      p.draft(section, "");
    }
  };
  return (
    <section className="v-mission">
      <header className="v-mission-header">
        <div>
          <span className="v-label">
            {p.owner ? "YOUR MISSION" : "CONTRIBUTING"}
          </span>
          <h1>{p.brief.name}</h1>
        </div>
        <div className="v-action-row">
          <Tag tone={p.phase === "active" ? "progress" : "neutral"}>
            {
              {
                preparing: "Preparing",
                active: "In progress",
                paused: "Paused",
                closed: "Complete",
              }[p.phase]
            }
          </Tag>
          {p.owner && p.phase !== "preparing" && p.phase !== "closed" ? (
            <Button quiet onClick={p.pause}>
              <Pause size={15} />
              {p.phase === "paused" ? "Resume mission" : "Pause"}
            </Button>
          ) : null}
          {p.owner ? (
            <Button onClick={p.invite}>
              <Users size={16} />
              Invite someone
            </Button>
          ) : (
            <Button onClick={() => p.navigate("agents")}>
              My contribution
              <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </header>
      <div className="v-mission-tabs" aria-label="Mission sections">
        {[
          ["main", "Conversation"],
          ["work", "Work"],
          ["people", "People"],
          ["brief", "Brief"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={
              section === id || (id === "main" && conversation)
                ? "page"
                : undefined
            }
            onClick={() => p.navigate(`mission/${id}`)}
          >
            {label}
            {id === "work" && !p.created ? <span>3</span> : null}
          </button>
        ))}
        <span>
          {p.created
            ? "Your goal, your team"
            : `${p.agents.length} agents · 2 people`}
        </span>
      </div>
      {p.delayed ? (
        <div className="v-connection-note">
          Updates from Sam’s Mac are delayed.{" "}
          <button onClick={() => p.navigate("mission/people")}>
            View connection
          </button>
        </div>
      ) : null}
      {p.phase === "paused" ? (
        <div className="v-paused-note">
          Mission paused by you. Saved work and conversations are available.
        </div>
      ) : null}
      {conversation ? (
        <div className="v-conversation-layout">
          <div className="v-conversation">
            <div className="v-channel-heading">
              <div>
                {privateChat ? <LockKeyhole size={17} /> : <Hash size={19} />}
                <strong>{channelName}</strong>
                <span>{channelPurpose}</span>
              </div>
              <input
                aria-label="Search this conversation"
                placeholder="Search this conversation"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {!p.created && !privateChat && section === "main" ? (
              <div className="v-result-strip">
                <FileText size={18} />
                <div>
                  <strong>Family timetable</strong>
                  <span>
                    {p.accepted
                      ? "Accepted version 3"
                      : "Version 3 · ready for your review"}
                  </span>
                </div>
                <Button quiet onClick={p.review}>
                  {p.accepted ? "Open result" : "Review result"}
                  <ArrowRight size={16} />
                </Button>
              </div>
            ) : null}
            <div
              className="v-message-list"
              ref={list}
              onScroll={() => {
                const element = list.current;
                if (!element || search) return;
                p.scrollPositions[section] = element.scrollTop;
                atEnd.current =
                  element.scrollHeight -
                    element.clientHeight -
                    element.scrollTop <
                  40;
              }}
              aria-label={`${channelName} messages`}
            >
              {p.created && p.phase === "preparing" ? (
                <div className="v-channel-start">
                  <span className="v-label">THE START OF SOMETHING</span>
                  <h2>Your mission has a home.</h2>
                  <p>{p.brief.goal}</p>
                  <p>
                    Set up your Coordinator to work out the approach with you.
                  </p>
                  <Button primary onClick={() => p.navigate("setup")}>
                    Set up Coordinator
                    <ArrowRight size={16} />
                  </Button>
                </div>
              ) : null}
              {privateChat ? (
                <p className="v-privacy-line">
                  <LockKeyhole size={14} />
                  You and {channelName}. The contributor hosting this agent can
                  access its workspace.
                </p>
              ) : null}
              {!visible.length && search ? (
                <p className="v-empty-note">No messages match “{search}”.</p>
              ) : null}
              {visible.map((m) => (
                <article key={m.id} className="v-message">
                  {p.agents.some((a) => a.name === m.author) ? (
                    <button
                      className="v-avatar-button"
                      aria-label={`About ${m.author}`}
                      onClick={() => {
                        const a = p.agents.find((a) => a.name === m.author);
                        if (a) setProfile(a);
                      }}
                    >
                      <Avatar
                        name={m.author}
                        coordinator={m.role === "Coordinator"}
                      />
                    </button>
                  ) : (
                    <Avatar
                      name={m.author}
                      coordinator={m.role === "Coordinator"}
                    />
                  )}
                  <div>
                    <header>
                      <strong>{m.author}</strong>
                      {m.role !== "Human" ? (
                        <span
                          className={
                            m.role === "Coordinator"
                              ? "v-role coordinator"
                              : "v-role"
                          }
                        >
                          {m.role}
                        </span>
                      ) : null}
                      <time>{m.time}</time>
                    </header>
                    <p>{m.text}</p>
                    {m.attachment ? (
                      <a
                        className="v-message-attachment"
                        href="/#preview"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <div className="v-mini-timetable" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </div>
                        <div>
                          <strong>Family timetable</strong>
                          <span>Interactive guide · version 3</span>
                        </div>
                        <ArrowUpRight size={18} />
                      </a>
                    ) : null}
                    <button
                      className="v-thread-link"
                      onClick={() => {
                        setProfile(null);
                        setThread(m);
                      }}
                    >
                      <MessageSquare size={14} />
                      {threadCounts[m.id]
                        ? `${threadCounts[m.id]} ${threadCounts[m.id] === 1 ? "reply" : "replies"}`
                        : "Reply in thread"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <form
              className={`v-composer ${privateChat ? "private" : ""}`}
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div className="v-composer-target">
                {privateChat ? <LockKeyhole size={14} /> : <Hash size={15} />}
                <span>
                  {privateChat
                    ? `Message ${channelName} privately`
                    : `Message ${channelName}`}
                </span>
                {!privateChat ? <span>Visible to the mission</span> : null}
              </div>
              <textarea
                aria-label="Message"
                value={value}
                onChange={(e) => p.draft(section, e.target.value)}
                placeholder={
                  privateChat
                    ? "Ask a question or give an instruction…"
                    : "Add to the conversation…"
                }
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <footer>
                <small>⌘ Enter to send</small>
                <Button primary type="submit" disabled={!value.trim()}>
                  <Send size={16} />
                  Send
                </Button>
              </footer>
            </form>
          </div>
          {thread ? (
            <aside className="v-thread">
              <header>
                <h2>Thread</h2>
                <IconButton
                  label="Close thread"
                  onClick={() => setThread(null)}
                >
                  <X size={19} />
                </IconButton>
              </header>
              <article>
                <strong>{thread.author}</strong>
                <p>{thread.text}</p>
              </article>
              {thread.id === "m4" ? (
                <article>
                  <strong>
                    Robin{" "}
                    <span className="v-role coordinator">Coordinator</span>
                  </strong>
                  <p>
                    The revised schedule is reflected correctly. Parent testing
                    remains open.
                  </p>
                </article>
              ) : null}
              {p.messages
                .filter((m) => m.channel === `thread-${thread.id}`)
                .map((m) => (
                  <article key={m.id}>
                    <strong>{m.author}</strong>
                    <p>{m.text}</p>
                  </article>
                ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const k = `thread-${thread.id}`;
                  if (p.drafts[k]?.trim()) {
                    p.send(p.drafts[k], k);
                    p.draft(k, "");
                  }
                }}
              >
                <label className="v-field">
                  Reply
                  <textarea
                    value={p.drafts[`thread-${thread.id}`] || ""}
                    onChange={(e) =>
                      p.draft(`thread-${thread.id}`, e.target.value)
                    }
                    placeholder="Keep this discussion together…"
                  />
                </label>
                <Button
                  primary
                  type="submit"
                  disabled={!p.drafts[`thread-${thread.id}`]?.trim()}
                >
                  Reply
                </Button>
              </form>
            </aside>
          ) : null}
          {profile ? (
            <aside className="v-thread">
              <header>
                <h2>{profile.name}</h2>
                <IconButton
                  label="Close agent"
                  onClick={() => setProfile(null)}
                >
                  <X size={19} />
                </IconButton>
              </header>
              <Avatar
                name={profile.name}
                coordinator={profile.role === "Coordinator"}
              />
              <h3>{profile.role}</h3>
              <p>{profile.activity}</p>
              <dl className="v-facts">
                <div>
                  <dt>Runtime</dt>
                  <dd>{profile.runtime}</dd>
                </div>
                <div>
                  <dt>Contributed by</dt>
                  <dd>{profile.owner}</dd>
                </div>
              </dl>
              <Button
                onClick={() => p.navigate(`mission/${agentChannel(profile)}`)}
              >
                <LockKeyhole size={15} />
                Private message
              </Button>
              {profile.owner === "You" ? (
                <Button onClick={() => p.navigate("agents")}>
                  Manage on this Mac
                  <ArrowRight size={16} />
                </Button>
              ) : (
                <p className="v-help">
                  {profile.owner} controls this agent’s local execution.
                </p>
              )}
            </aside>
          ) : null}
        </div>
      ) : null}
      {section === "work" ? (
        <Work
          review={p.review}
          accepted={p.accepted}
          empty={p.created}
          owner={p.owner}
        />
      ) : null}
      {section === "people" ? (
        <People
          agents={p.agents}
          delayed={p.delayed}
          navigate={p.navigate}
          owner={p.owner}
        />
      ) : null}
      {section === "brief" ? (
        <MissionBrief brief={p.brief} change={p.changeBrief} owner={p.owner} />
      ) : null}
    </section>
  );
}

function Work({
  review,
  accepted,
  empty,
  owner,
}: {
  review: () => void;
  accepted: boolean;
  empty: boolean;
  owner: boolean;
}) {
  const [support, setSupport] = useState<string | null>(null);
  return (
    <div className="v-page v-work">
      <div className="v-section-title">
        <div>
          <h2>Shared work</h2>
          <p>Open what the team has made. See what has been checked.</p>
        </div>
      </div>
      {empty ? (
        <div className="v-empty-note">
          The first shared work will appear here. You can keep talking in Main.
        </div>
      ) : (
        <>
          <div className="v-featured-work">
            <div className="v-work-preview">
              <span className="v-label">LITTLE EXPLORERS / 2026</span>
              <h2>
                Big discoveries.
                <br />
                Little explorers.
              </h2>
              <div className="v-preview-days">
                <span>Saturday</span>
                <span>Sunday</span>
              </div>
              <div className="v-timetable-lines">
                <div>
                  <time>10:00</time>
                  <strong>Light & shadow</strong>
                  <span>Garden</span>
                </div>
                <div>
                  <time>11:00</time>
                  <strong>Kitchen chemistry</strong>
                  <span>Studio</span>
                </div>
                <div>
                  <time>13:00</time>
                  <strong>Build a robot</strong>
                  <span>Discovery Lab</span>
                </div>
              </div>
            </div>
            <div className="v-work-description">
              <span className="v-label">CURRENT RESULT</span>
              <h2>Family timetable</h2>
              <p>
                A clear guide to both festival days, with activities, locations
                and travel time.
              </p>
              <div className="v-work-meta">
                <Avatar name="Wren" small />
                <span>Wren · version 3 · 10:39</span>
              </div>
              <Tag tone={accepted ? "success" : "warning"}>
                {accepted
                  ? "Accepted by owner"
                  : owner
                    ? "Your review needed"
                    : "Owner review requested"}
              </Tag>
              <p className="v-help">
                Schedule checks passed. Testing with a real family is still
                open.
              </p>
              <div className="v-action-row">
                <PreviewLink>Open preview</PreviewLink>
                <Button primary onClick={review}>
                  {accepted ? "View review" : "Review this version"}
                  <ArrowRight size={16} />
                </Button>
              </div>
            </div>
          </div>
          <div className="v-section-title v-space-top">
            <h3>Supporting work</h3>
            <span className="v-muted">2 artifacts</span>
          </div>
          {[
            {
              name: "Festival programme",
              kind: "Schedule",
              who: "Finch",
              version: 4,
            },
            {
              name: "Venue & staffing review",
              kind: "Review",
              who: "Robin",
              version: 2,
            },
          ].map((a) => (
            <button
              key={a.name}
              className="v-work-row"
              onClick={() => setSupport(a.name)}
            >
              <FileText size={23} />
              <div>
                <strong>{a.name}</strong>
                <span>
                  {a.kind} · {a.who} · version {a.version}
                </span>
              </div>
              <Tag tone="success">Checked</Tag>
              <ChevronRight size={18} />
            </button>
          ))}
          {support ? (
            <Modal title={support} close={() => setSupport(null)}>
              <Tag>Sample artifact</Tag>
              <p>
                {support === "Festival programme"
                  ? "Version 4 · Finch. Robotics moves to Saturday at 13:00 in the Discovery Lab. The schedule preserves a 15-minute interval between activities."
                  : "Version 2 · Robin. Room capacity and activity overlap checks pass for the revised programme. Accessibility and parent testing still need real-world verification."}
              </p>
              <Details title="Exact review scope">
                <p>
                  This is fictional content for the interface preview. The
                  connected product opens the actual files, revision and review
                  evidence.
                </p>
              </Details>
              <Button
                onClick={() => {
                  setSupport(null);
                  review();
                }}
              >
                View the delivery candidate
                <ArrowRight size={16} />
              </Button>
            </Modal>
          ) : null}
        </>
      )}
    </div>
  );
}
function People({
  agents,
  delayed,
  navigate,
  owner,
}: {
  agents: Agent[];
  delayed: boolean;
  navigate: (s: string) => void;
  owner: boolean;
}) {
  return (
    <div className="v-page">
      <div className="v-section-title">
        <div>
          <h2>People & agents</h2>
          <p>See who is contributing and what their agents are working on.</p>
        </div>
      </div>
      {agents.length ? (
        agents.map((a) => (
          <div className="v-person-row" key={a.id}>
            <Avatar name={a.name} coordinator={a.role === "Coordinator"} />
            <div>
              <strong>
                {a.name}
                <span className="v-role">{a.role}</span>
              </strong>
              <span>
                {a.runtime} ·{" "}
                {a.owner === "You" ? "Your Mac" : `${a.owner}’s Mac`}
              </span>
              <p>
                {delayed && a.owner !== "You"
                  ? "Last update 4 minutes ago. Current activity is unknown."
                  : a.activity}
              </p>
            </div>
            <Button
              quiet
              onClick={() => navigate(`mission/${agentChannel(a)}`)}
            >
              <MessageSquare size={16} />
              Message
            </Button>
          </div>
        ))
      ) : (
        <p>No agents have joined yet.</p>
      )}
      <Details title="Connection and membership details">
        <dl className="v-facts">
          <div>
            <dt>Your Mac</dt>
            <dd>Local records available</dd>
          </div>
          <div>
            <dt>Sam’s Mac</dt>
            <dd>
              {delayed
                ? "Unreachable · retrying connection"
                : "Updates received recently"}
            </dd>
          </div>
          <div>
            <dt>Mission owner</dt>
            <dd>{owner ? "You" : "Sam"}</dd>
          </div>
        </dl>
        <p>
          Connection observations describe delivery, not whether an agent is
          making useful progress.
        </p>
      </Details>
    </div>
  );
}
function MissionBrief({
  brief,
  change,
  owner,
}: {
  brief: Brief;
  change: (b: Brief) => void;
  owner: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(brief);
  return (
    <div className="v-page v-brief-page">
      <div className="v-section-title">
        <div>
          <span className="v-label">THE SHARED DESTINATION</span>
          <h2>Mission brief</h2>
        </div>
        {owner ? (
          <Button
            onClick={() => {
              setValue(brief);
              setEditing(!editing);
            }}
          >
            {editing ? "Cancel editing" : "Edit brief"}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            change(value);
            setEditing(false);
          }}
        >
          <label className="v-field">
            Goal
            <textarea
              required
              value={value.goal}
              onChange={(e) =>
                setValue((v) => ({ ...v, goal: e.target.value }))
              }
            />
          </label>
          <label className="v-field">
            Scope
            <textarea
              required
              rows={4}
              value={value.scope}
              onChange={(e) =>
                setValue((v) => ({ ...v, scope: e.target.value }))
              }
            />
          </label>
          <p className="v-help">
            Changing the brief pauses affected work for renewed contributor
            approval.
          </p>
          <Button primary type="submit">
            Save changed brief
          </Button>
        </form>
      ) : (
        <>
          <h3>Goal</h3>
          <p className="v-brief-goal">{brief.goal}</p>
          <h3>Scope</h3>
          <p>{brief.scope}</p>
          <h3>What success looks like</h3>
          <ol className="v-outcomes">
            {brief.criteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <Details title="Approach and resources">
            <p>
              Coordinator-led collaboration. Tasks and additional workstreams
              are optional.
            </p>
            <p>
              No shared usage limit. Each contributor sets a finite local
              permission.
            </p>
          </Details>
          <Details title="Technical record">
            <p>
              In the connected application, exact instruction revisions,
              signatures and authority records are available here.
            </p>
            <span className="v-label">SAMPLE DATA · NOT A SIGNED MISSION</span>
          </Details>
        </>
      )}
    </div>
  );
}

export function ArtifactReview({
  accepted,
  owner,
  accept,
  request,
}: {
  accepted: boolean;
  owner: boolean;
  accept: () => void;
  request: (text: string) => void;
}) {
  const [reviewed, setReviewed] = useState(false),
    [changes, setChanges] = useState(false),
    [note, setNote] = useState("");
  return (
    <div className="v-review">
      <div className="v-review-title">
        <Tag tone={accepted ? "success" : "warning"}>
          {accepted
            ? "Accepted"
            : owner
              ? "Ready for your decision"
              : "Owner review requested"}
        </Tag>
        <h2>Family timetable</h2>
        <p>Version 3 · published by Wren · reviewed by Robin</p>
        <PreviewLink>Open the actual work</PreviewLink>
      </div>
      <div className="v-review-checks">
        <h3>What was checked</h3>
        <p>
          <Check size={16} />
          Room capacities and activity times
        </p>
        <p>
          <Check size={16} />
          Phone layout and day navigation
        </p>
        <p className="v-unverified">
          ○ Usability with a real family — not tested
        </p>
      </div>
      <Details title="Evidence and version history">
        <p>
          The connected app links each check to this exact artifact revision.
          Changing the artifact requires a fresh review.
        </p>
        <p>
          This prototype uses a sample timetable and sample review; it is not
          mission evidence.
        </p>
      </Details>
      {!accepted ? (
        <>
          {owner ? (
            <label className="v-check">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>
                I reviewed version 3 and accept the remaining limitation.
              </span>
            </label>
          ) : (
            <p className="v-help">
              Sam owns the mission and accepts the final result. You can review
              the work and suggest changes.
            </p>
          )}
          <div className="v-action-row">
            <Button onClick={() => setChanges(!changes)}>
              Request changes
            </Button>
            {owner ? (
              <Button primary disabled={!reviewed} onClick={accept}>
                Accept version 3<Check size={16} />
              </Button>
            ) : null}
          </div>
          {changes ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) request(note);
              }}
            >
              <label className="v-field">
                What needs to change?
                <textarea
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <Button primary type="submit" disabled={!note.trim()}>
                Send to Coordinator
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <p className="v-help">
          This version is accepted. Mission closure remains a separate owner
          decision.
        </p>
      )}
    </div>
  );
}

export function ArtifactPreview() {
  const [day, setDay] = useState("Saturday");
  const items =
    day === "Saturday"
      ? [
          ["10:00", "Light & shadow", "Garden"],
          ["11:00", "Kitchen chemistry", "Studio"],
          ["13:00", "Build a robot", "Discovery Lab"],
        ]
      : [
          ["10:00", "A world under the microscope", "Discovery Lab"],
          ["11:30", "Make a mini ecosystem", "Garden"],
          ["14:00", "The great science show", "Studio"],
        ];
  return (
    <main className="v-artifact-demo" data-theme="light">
      <div className="v-preview-disclaimer">
        SAMPLE ARTIFACT · FRONTEND EXPERIENCE PROTOTYPE
      </div>
      <header>
        <span className="v-label">LITTLE EXPLORERS / THE FAMILY GUIDE</span>
        <h1>
          Big discoveries.
          <br />
          Little explorers.
        </h1>
        <p>Two days of making, questioning and wonderful surprises.</p>
      </header>
      <div className="v-segment">
        {["Saturday", "Sunday"].map((d) => (
          <button key={d} aria-pressed={d === day} onClick={() => setDay(d)}>
            {d}
          </button>
        ))}
      </div>
      <section>
        {items.map(([time, title, room]) => (
          <article key={title}>
            <time>{time}</time>
            <div>
              <h2>{title}</h2>
              <p>{room} · 45 minutes · Ages 6–12</p>
            </div>
            <span>Explore together ↗</span>
          </article>
        ))}
      </section>
      <footer>
        Allow 15 minutes between activities. Ask a volunteer if you need an
        accessible route.
      </footer>
    </main>
  );
}
