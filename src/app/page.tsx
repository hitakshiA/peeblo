import { Anatomy } from "@/components/sections/Anatomy";
import { Connectors } from "@/components/sections/Connectors";
import { Crew } from "@/components/sections/Crew";
import { Cta } from "@/components/sections/Cta";
import { SlackDeep } from "@/components/sections/SlackDeep";
import { Closing } from "@/components/sections/Closing";
import { Faq } from "@/components/sections/Faq";
import { Hero } from "@/components/sections/Hero";
import { How } from "@/components/sections/How";
import { Nav } from "@/components/sections/Nav";
import { SelfHost } from "@/components/sections/SelfHost";
import { Trio } from "@/components/sections/Trio";
import { UseCases } from "@/components/sections/UseCases";
import { OtariSection } from "@/components/sections/OtariSection";
import { CursorFx } from "@/components/peeblo/cursor-fx";

// The landing page, top to bottom.
export default function Home() {
  return (
    <>
      <div className="pb-grain" aria-hidden="true" />
      <CursorFx />
      <Nav />
      <main>
        <Hero />
        <Trio />
        <Crew />
        <UseCases />
        <Anatomy />
        <How />
        <SlackDeep />
        <OtariSection />
        <Connectors />
        <SelfHost />
        <Faq />
        <Cta />
      </main>
      <Closing />
    </>
  );
}
