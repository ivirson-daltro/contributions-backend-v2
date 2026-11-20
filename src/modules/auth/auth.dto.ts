import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const acceptInvitationSchema = z
  .object({
    displayName: z.string().trim().min(1).optional(),
    password: z
      .string()
      .min(8)
      .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.displayName === undefined) !== (value.password === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "displayName e password devem ser enviados juntos",
      });
    }
  });

export class AcceptInvitationDto extends createZodDto(acceptInvitationSchema) {}
