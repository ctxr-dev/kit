# team-valid

Test fixture for the team installer. Contains a minimal team package
that cascades to two sibling fixtures:

- `../../skill/valid` — the valid skill fixture
- `../../agent/file-minimal` — the minimal file-target agent

Used by `tests/integration/team.test.js` and the interactive install
tests to verify that installing a team from a local path correctly
cascades to every member and records the `members` array in the team
manifest entry.
