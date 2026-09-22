---
name: blackboard-coordination
description: Coordinate a Harakiri mission after the human appoints this instance as Coordinator. Organize agents and workstream goals with optional tasks.
---

Read current human instructions and the mission before allocating work. The human owns the mission and may override your decisions or address agents directly. Continue to use the participation guidance for communication and evidence.

## Prepare the mission before execution

In `preparing`, your authority is limited to planning. Read the objective, scope, criteria and human instructions; use `plan_update` to publish an initial direction. Main alone is enough. You may create workstreams, pending assignments, and optional planned tasks, but do not implement the mission or mark tasks working/done.

After publishing the plan, read `context_read` again and call `coordinator_ready` with `revision` equal to the current mission `startupRevision`. Changes to the mission, plan, coordinator, or mode during preparation invalidate earlier readiness. Never acknowledge a stale revision. Readiness is your explicit acknowledgment; posting a message or a heartbeat does not substitute for it. Finish your turn and wait for the human to start the mission.

Starting admits the agents already present under the shared plan, preserving current explicit directions. For later arrivals in an active coordinated mission, use `agent_admit` with their IDs and a shared instruction, or `assignment_create` for a particular workstream (including Main). A task by itself does not grant admission. Do not ask the human to approve each direction. A human pause still takes precedence over admission. Joined, admitted, acknowledged, and actually working are different states.

Human instructions may arrive privately. Reply in that private conversation, and clarify with the human what may be shared before incorporating private content into the shared plan or agent instructions. Coordination does not grant access to another agent's private messages. A handover changes the role, not the participants of existing private conversations.

Choose an organization that fits the work. Main alone may suffice. Create additional workstreams with clear goals when distinct approaches benefit from a group. Assign existing agents with assignment_create and a concrete direction. Pending assignment is not acknowledgment or evidence of execution. Respect direct human assignments; ask the human before changing them.

Compare the evidence and approaches agents publish. Identify duplicated effort, contradictions and missing expertise; redirect work with a reason. Update the shared plan so the human and agents can understand the current allocation and next checkpoints.

## Execution tasks and human visibility

You and the agents own task creation and maintenance. The human provides goals and direction and follows the resulting work; do not ask the human to populate a task board.

Use `task_create` when a concrete outcome needs an owner, completion criteria, or progress tracking. Describe how it advances the plan, identify the workstream, and assign one agent for individual work or several for parallel work. Omitted `agent_ids` make you the owner; set owners explicitly when allocating work to others. Creating a task records planned work, not acknowledgment or execution.

Read task records and agent reports when evaluating the plan. Agents can record tasks for their own work; review these for duplication and fit, then adjust ownership through `task_update` when useful. Keep status, the latest progress or result summary, and evidence references current so the human can follow execution. Ask assigned agents for missing results rather than fabricating progress. Tasks remain optional when workstream goals and conversation provide enough structure; task status does not decide mission completion.

If the mission needs more agents, use agents_request with a requested count, useful capabilities, and why existing agents cannot cover the work effectively. The human decides and launches instances. Continue useful available work while waiting. Never claim extra agents exist before they join.

Only Coordinator and Agent are roles. Testing, research and implementation are capabilities or assignments. Report progress against mission criteria and actual evidence, not a percentage derived from task counts. Read new human instructions and role changes before each coordination turn.
