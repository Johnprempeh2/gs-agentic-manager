import { MovementChip, RatingStars, SourceLink, VerdictCard } from "./IntelligenceCards";
import { BrandLogo, TagChip } from "./IntelligenceMedia";

/** Sample data for the design guide's "Intelligence cards" section. */
export function IntelligenceDesignExamples() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <VerdictCard
          eyebrow="Meta · Models · 12 Oct"
          title="Meta releases Muse Wonder, its first frontier model"
          href="https://example.com/muse-wonder"
          verdict="Meta now has a model within reach of the leaders, at leader prices."
          points={[
            "Scores 52 on the Artificial Analysis index, ninth overall.",
            "Priced at $4 input and $20 output per million tokens.",
            "Parity claims with GPT-6 Astra are Meta's own tests.",
            "A fourth point stays in the drawer.",
          ]}
          action="Run Muse Wonder against Sonnet on 20 client tasks, scoring quality and cost per task."
          analysis={<p>The long analysis (150 to 250 words) and the Greatstone lens live here, never on the card.</p>}
          footer={<SourceLink href="https://example.com/muse-wonder">TechCrunch</SourceLink>}
        />
        <VerdictCard
          leading={<BrandLogo name="Cline" domain="cline.bot" size="lg" />}
          eyebrow={<><TagChip>AI coding</TagChip><span>Free</span></>}
          title="Cline"
          href="https://example.com/cline"
          verdict="Open-source coding agent for the IDE and the command line."
          meta={
            <>
              <RatingStars value={4} label="Personal" />
              <RatingStars value={5} label="Client" />
            </>
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <BrandLogo name="Anthropic" domain="anthropic.com" size="xl" />
        <BrandLogo name="OpenAI" domain="openai.com" size="lg" />
        <BrandLogo name="Google DeepMind" domain="deepmind.google" size="md" />
        <BrandLogo name="Cline" size="sm" />
        <span className="text-xs text-muted-foreground">Logo by domain through our server; with no key or no match, a monogram.</span>
        <TagChip>Models</TagChip>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="inline-flex items-center gap-2">Up two <MovementChip movement={{ rankDelta: 2, scoreDelta: 1.4, isNew: false }} /></span>
        <span className="inline-flex items-center gap-2">Down one <MovementChip movement={{ rankDelta: -1, scoreDelta: -0.6, isNew: false }} /></span>
        <span className="inline-flex items-center gap-2">No change <MovementChip movement={{ rankDelta: 0, scoreDelta: 0, isNew: false }} /></span>
        <span className="inline-flex items-center gap-2">New entry <MovementChip movement={{ rankDelta: null, scoreDelta: null, isNew: true }} /></span>
      </div>
    </div>
  );
}
