import { OnboardingWizard } from "./OnboardingWizard";

/**
 * Default onboarding wizard. No experimental flag gates onboarding; the
 * conference-room chat flag that once did graduated in GRE-1624.
 */
export function OnboardingWizardVariant() {
  return <OnboardingWizard />;
}
