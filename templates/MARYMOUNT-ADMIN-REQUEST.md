# Draft: request for a Marymount Canvas OAuth developer key

**Operator action:** replace bracketed values with real reviewed details. Do not send as-is. This is a request template, not a statement that the app has passed review or that approval exists.

Subject: Student-developed Canvas assignment planner: scoped OAuth pilot request

Hello,

I am a Marymount student developing **Due Good**, an independent, optional assignment planner intended to help students keep track of their Canvas deadlines and personal next steps. I would like to begin with a small Marymount pilot.

The planned student experience is to open the website, authorize their own Canvas connection, choose courses, and see an assignment list. Students would not give the application their university password or manually generate an API token.

Could the Canvas administrator advise on review and enablement of a scoped Canvas API OAuth developer key?

Proposed pilot configuration:

- Application name: Due Good
- Application origin: [actual stable HTTPS deployment origin]
- Exact OAuth redirect: [actual origin]/auth/canvas/callback
- Operator/support contact: [real contact]
- Source repository: [actual public repository after creation and review]
- Privacy/security information: [actual reviewed page or attachment]
- Initial read scopes: `url:GET|/api/v1/courses` and `url:GET|/api/v1/courses/:course_id/assignments`
- Include-parameter setting: request “Allow Include Parameters” for the student's own submission information
- No Canvas coursework write scopes, assignment submission, grade modification, messaging, student roster collection, or shared administrator token
- Initial pilot size: [reviewed admission limit]

The proposed backend uses Cloudflare Workers and D1. Canvas credentials would be stored encrypted on the backend, with no Canvas token in the browser. This architecture is still being implemented and will need validation before students are invited. I can provide the specification, requested scopes, security/deletion design, and a synthetic-data demonstration for review.

Please let me know the appropriate approval process, any required institutional agreements or privacy review, and whether a test environment/key is available. I do not intend to present the tool as a university-endorsed service without permission.

Thank you,
[Name]
