
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        const result = await env.DB
          .prepare(
            "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = ?"
          )
          .bind("hr_cases")
          .first();

        return Response.json({
          database: "connected",
          hr_cases_table: result.total === 1
        });
      } catch (error) {
        return Response.json({
          database: "not connected"
        }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
