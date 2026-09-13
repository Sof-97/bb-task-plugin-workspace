export const statuses = [
  "Inbox",
  "Research",
  "Ready to implement",
  "In progress",
  "Ready for agent review",
  "Ready for human review",
  "In testing",
  "Completed",
  "Blocked",
] as const;
export const normalStatuses = statuses.filter((value) => value !== "Blocked");
