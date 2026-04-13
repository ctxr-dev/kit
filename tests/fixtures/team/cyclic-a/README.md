# team-cyclic-a

Half of a cycle fixture. `team-cyclic-a` includes `../cyclic-b`, and
`team-cyclic-b` in turn includes `../cyclic-a` — installing either one
should trip kit's cycle-detection guard in the team installer and
surface a clear error instead of infinite recursion.
