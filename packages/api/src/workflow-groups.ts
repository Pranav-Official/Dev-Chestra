import { z } from "zod";

const groupId = z.string().regex(/^grp_[a-f0-9]{24}$/u);
const workflowId = z.string().regex(/^[a-z0-9-]{1,64}$/u);
export const workflowGroupsDocumentSchema = z
  .object({
    version: z.literal(1),
    groups: z
      .array(z.object({ id: groupId, name: z.string().trim().min(1).max(100) }).strict())
      .max(1000),
    memberships: z.record(workflowId, groupId),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const group of doc.groups) {
      const name = group.name.toLocaleLowerCase("en-US");
      if (ids.has(group.id) || names.has(name))
        ctx.addIssue({ code: "custom", message: "Group IDs and names must be unique." });
      ids.add(group.id);
      names.add(name);
    }
    for (const id of Object.values(doc.memberships)) {
      if (!ids.has(id))
        ctx.addIssue({ code: "custom", message: "Membership references an unknown group." });
    }
  });
export const workflowGroupsResponseSchema = z
  .object({
    document: workflowGroupsDocumentSchema,
    etag: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type WorkflowGroupsDocument = z.infer<typeof workflowGroupsDocumentSchema>;
export type WorkflowGroupsResponse = z.infer<typeof workflowGroupsResponseSchema>;
