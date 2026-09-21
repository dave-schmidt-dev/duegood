# Synthetic fixtures

`planner-scenarios.json` contains invented courses in computing, political science, and art, plus normalized planning scenarios. None of the records comes from the owner's coursework exports.

The checkpoint objects are **proposed application-model objects**, not exact Canvas API responses. A local agent must derive and test the actual Canvas adapter from current primary documentation and authorized captures that remain private.

The package tests validate fixture structure and estimator arithmetic. They do not implement or prove the expected synchronization behaviors described in each scenario. Use those descriptions as inputs to later application tests.

`local-coursework-contract.json` is a hand-authored synthetic example of the
private local document contract. Its course names, identifiers, dates, URLs,
scores, and extension fields are invented. It deliberately includes completed,
submitted, graded, undated, and archived records plus unknown fields so the
local adapter can prove lossless round trips without private source data.
