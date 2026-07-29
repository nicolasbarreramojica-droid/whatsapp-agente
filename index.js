const relevanceRes = await fetch(
  `https://api-bcbe5a.stack.tryrelevance.com/latest/agents/trigger`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RELEVANCE_API_KEY}`,
    },
    body: JSON.stringify({
      agent_id: RELEVANCE_AGENT_ID,
      message: { role: "user", content: text },
    }),
  }
);
