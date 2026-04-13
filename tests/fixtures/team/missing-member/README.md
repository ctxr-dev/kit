# team-missing-member

Team fixture with one valid member and one that points at a nonexistent
local path. Exercises kit's batch-continue rule: the valid member
installs successfully while the missing member records an error on the
batch report, and the overall team entry records only the installed
members in its `members` array.
