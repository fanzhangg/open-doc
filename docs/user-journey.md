# User Journey

## How to Use This Doc

- The step-by-step experience open-doc should give, written so an agent can check the product against it
- Each journey: where the user starts, what they do, what they see, and what must hold
- When reviewing a change, walk the affected journeys and flag any step that no longer matches

## The User

- One or two lines: someone who writes markdown docs with an AI agent, locally, next to their code (see the vision doc)

## Journey 1: Open a Doc

- **Start:** a markdown file on disk, agent set up or not
- **Steps:** open the doc, the editor shows it, the agent is on standby
- **Must hold:**
- **Must never happen:**

## Journey 2: Ask for an Edit

- **Start:** doc open, agent on standby
- **Steps:** select text, comment, see the agent responding, see the edit land in the doc, read the reply in the thread
- **Must hold:**
- **Must never happen:**

## Journey 3: Keep Writing While the Agent Works

- **Start:** the agent is handling a comment
- **Steps:** keep typing elsewhere; type in the same paragraph the agent is editing
- **Must hold:**
- **Must never happen:**

## Journey 4: Review the Agent's Work

- **Start:** the agent replied and the thread waits on the user
- **Steps:** accept and resolve, undo the edit, or reply to ask for more
- **Must hold:**
- **Must never happen:**

## Journey 5: Ask for a Proposal First

- **Start:** the user wants to approve changes before they land
- **Steps:** ask for a proposal (or turn on approve-every-change), see the suggested changes, apply or reject
- **Must hold:**
- **Must never happen:**

## Journey 6: The Agent Needs the User

- **Start:** the agent can't finish without a decision or a fact
- **Steps:** the agent asks in the thread or starts a new thread, the user answers
- **Must hold:**
- **Must never happen:**

## Journey 7: The Commented Text Is Gone

- **Start:** a thread's text was rewritten or deleted
- **Steps:** the thread shows as detached, the agent finds where the content went or asks
- **Must hold:**
- **Must never happen:**

## Journey 8: Several Agents in One Doc (Later)

- **Start:** more than one agent connected
- **Steps:** mention one agent with `@name`, leave a comment for anyone
- **Must hold:**
- **Must never happen:**

## Rules for Every Journey

- Rules that hold in every step (for example: the agent only changes what the comment is about; only the user resolves a thread; every change is explained in the thread and can be undone)

## Not Covered

- Experiences we deliberately leave out (for example: chat window, cloud sync, people co-editing)
