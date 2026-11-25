import { z } from 'zod';

export const PaneBoxSchema = z.object({ height: z.number(), scrollHeight: z.number(), scrollTop: z.number() });
const PanelFitSchema = z.object({ fits: z.boolean(), panelHeight: z.number(), paneHeight: z.number() });
export const LayoutReportSchema = z.object({
  wide: z.object({ sideBySide: z.boolean(), conversation: PaneBoxSchema, tasks: PaneBoxSchema, runLineVisible: z.boolean(), panelFillsColumn: z.boolean() }),
  grown: z.object({ conversation: PaneBoxSchema, runLineVisible: z.boolean() }),
  scrolledAway: z.object({ conversationTop: z.number(), tasksMoved: z.boolean() }),
  expanded: z.object({ runLineVisible: z.boolean(), listHeight: z.number(), listAtEnd: z.boolean() }),
  fitted: z.object({ short: PanelFitSchema, middle: PanelFitSchema, tall: PanelFitSchema }),
  narrow: z.object({ stacked: z.boolean() }),
});
export type LayoutReport = z.infer<typeof LayoutReportSchema>;
