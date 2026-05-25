---
name: storyboard-gen
description: Generate and validate storyboard JSON using the configured LLM. Apply when user wants to create a storyboard, test storyboard generation, or debug storyboard output quality.
---

# Storyboard Generation Skill

## When invoked:
1. Read `src/core/llm/` to understand available adapters
2. Read `.Codex/agents/storyboard-architect.md` for schema reference
3. Apply the generation pipeline below

## Generation Steps

### 1. Build the system prompt
```python
SYSTEM_PROMPT = """You are a professional cinematographer and screenwriter.
Generate a detailed cinematic storyboard as valid JSON.
Follow the exact schema provided. No markdown, no explanation.
Focus on visual storytelling, cinematic camera work, and emotional arcs.
Each shot must have distinct first_frame and last_frame that imply clear motion."""
```

### 2. Build the user prompt (token-efficient)
```python
def build_storyboard_prompt(req: StoryboardRequest) -> str:
    return f"""Create a {req.duration_sec}s cinematic storyboard.

Genre: {req.genre}
Style: {req.style}  
Story: {req.user_prompt}
Scenes: {req.num_scenes}
Aspect ratio: {req.aspect_ratio}

Return JSON matching this schema exactly:
@docs/storyboard_schema.json"""
```

### 3. Validate output
- Parse JSON (retry once with correction if invalid)
- Check all required fields present
- Validate shot durations sum to scene durations
- Validate scene durations sum to total

### 4. Correction prompt (if JSON invalid)
```
The JSON you returned was invalid. Error: {error}
Return ONLY valid JSON. Start with { and end with }
```

### 5. Save to project
Write to `~/.cinematic-studio/projects/{id}/storyboard.json`
Update project DB record with `storyboard_generated_at` timestamp

## Common Issues & Fixes
- LLM returns markdown fences: strip with regex `r'```json?\n?(.*?)```'`
- LLM truncates: increase max_tokens to 4096
- Durations don't add up: add validation + auto-correction step
- Invalid camera_movement value: normalize against allowed enum list
