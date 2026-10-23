// Isolated, explicitly fictional preview data. No host adapter, mission store,
// provider login, peer networking or execution capability is imported here.
export type Runtime = "Grok Build" | "Claude Code" | "Codex";
export type Phase = "preparing" | "active" | "paused" | "closed";
export type Brief = {
  name: string;
  goal: string;
  scope: string;
  criteria: string[];
};
export type Message = {
  id: string;
  author: string;
  role: "Coordinator" | "Agent" | "Human";
  time: string;
  text: string;
  channel: string;
  attachment?: boolean;
};
export type Agent = {
  id: string;
  name: string;
  role: "Coordinator" | "Agent";
  owner: string;
  runtime: Runtime;
  permission?: { minutes: number; turns: number; internet: boolean };
  activity: string;
  state: "working" | "waiting" | "stopped" | "stopping";
};
export function agentChannel(agent: Agent) {
  return `dm-${encodeURIComponent(agent.name.toLowerCase())}`;
}
export const festival: Brief = {
  name: "Little Explorers",
  goal: "Make a two-day science festival that 120 families will love.",
  scope:
    "A practical festival programme, a public timetable and an operating guide. Use the three available venues and a £12,000 budget. No bookings or purchases.",
  criteria: [
    "A feasible schedule for both days",
    "A timetable families can use on a phone",
    "A clear staffing and contingency plan",
  ],
};
export const initialAgents: Agent[] = [
  {
    id: "coord",
    name: "Robin",
    role: "Coordinator",
    owner: "You",
    runtime: "Grok Build",
    activity: "Bringing the final programme together",
    state: "working",
  },
  {
    id: "schedule",
    name: "Finch",
    role: "Agent",
    owner: "Sam",
    runtime: "Claude Code",
    activity: "Checking the revised room capacities",
    state: "working",
  },
  {
    id: "builder",
    name: "Wren",
    role: "Agent",
    owner: "You",
    runtime: "Codex",
    activity: "Waiting for the programme review",
    state: "waiting",
  },
];
export const initialMessages: Message[] = [
  {
    id: "m1",
    author: "You",
    role: "Human",
    time: "10:14",
    channel: "main",
    text: "The Discovery Lab will be unavailable on Saturday morning. Can we keep the robotics activity in the programme?",
  },
  {
    id: "m2",
    author: "Robin",
    role: "Coordinator",
    time: "10:16",
    channel: "main",
    text: "Yes. Finch is checking a move to the afternoon. Wren will update the family timetable once the new schedule is confirmed.\n\nWe’ll keep the other activities in place and check that families can still reach each venue in time.",
  },
  {
    id: "m3",
    author: "Finch",
    role: "Agent",
    time: "10:28",
    channel: "main",
    text: "The revised schedule works. Robotics can run at 13:00 in the Discovery Lab, with 15 minutes between activities. No other session needs to move.",
  },
  {
    id: "m4",
    author: "Wren",
    role: "Agent",
    time: "10:39",
    channel: "main",
    text: "The family timetable is updated. I added a day switcher and made the room changes visible on smaller screens.",
    attachment: true,
  },
  {
    id: "m5",
    author: "Robin",
    role: "Coordinator",
    time: "10:45",
    channel: "main",
    text: "The programme and timetable now agree. The venue checks passed. Before I call this ready, please review the family experience — we haven’t tested it with a real parent yet.",
  },
  {
    id: "s1",
    author: "Finch",
    role: "Agent",
    time: "10:22",
    channel: "programme",
    text: "I’m checking travel time between the garden and Discovery Lab. The afternoon robotics slot keeps the 15-minute gap we agreed.",
  },
  {
    id: "s2",
    author: "Robin",
    role: "Coordinator",
    time: "10:24",
    channel: "programme",
    text: "Keep the accessible route as the baseline. Please link the revised schedule in Main when the capacity check is finished.",
  },
  {
    id: "e1",
    author: "Wren",
    role: "Agent",
    time: "10:34",
    channel: "experience",
    text: "The Saturday/Sunday switcher is ready. I’m checking keyboard navigation and the narrow layout before publishing the revision.",
  },
  {
    id: "d1",
    author: "Robin",
    role: "Coordinator",
    time: "10:48",
    channel: "dm-robin",
    text: "Would you like us to include a quieter session for children who prefer a smaller group? I can ask Finch to check whether it fits the programme.",
  },
];
export const channelNames: Record<string, string> = {
  main: "Main",
  programme: "Programme",
  experience: "Family experience",
  "dm-robin": "Robin",
  "dm-wren": "Wren",
};
export const channelPurposes: Record<string, string> = {
  main: "Shared decisions and progress",
  programme: "Build a feasible two-day schedule",
  experience: "Make the festival easy to explore",
  "dm-robin": "Private conversation with your Coordinator",
  "dm-wren": "Private conversation with Wren",
};
export function timeNow() {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}
