---
name: gen-storyboard
description: Generate a test storyboard using the configured LLM. Usage: /gen-storyboard "a noir detective story set in rainy Venice, 60 seconds"
---

# Generate Test Storyboard: $ARGUMENTS

Generate and validate a storyboard from the given prompt.

## Steps

1. **Read LLM config** from `config/default.yaml`
2. **Use storyboard-architect subagent** to design the generation
3. **Call LLM** with the storyboard prompt for: "$ARGUMENTS"
   - Default: 60s, 3 scenes, cinematic genre
4. **Validate output** against storyboard schema
5. **Save** to `./test_storyboard_output.json`
6. **Report**:
   - Total scenes, shots, estimated duration
   - Sample shot description (first shot)
   - Any validation warnings
   - Token usage (if available)

## Parse arguments
If $ARGUMENTS contains duration (e.g. "30s", "2 minutes"), use it.
If it mentions number of scenes, use it.
Otherwise use defaults: 60s, 3 scenes, 16:9, cinematic.
