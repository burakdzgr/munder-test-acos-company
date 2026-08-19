-- LIFECYCLE TASK 11: agent model binding amaçları genişler —
-- default/coding/planning/review (router tercih listesiyle çözer).
ALTER TABLE "agent_model_bindings" DROP CONSTRAINT "agent_model_bindings_purpose_check";
ALTER TABLE "agent_model_bindings" ADD CONSTRAINT "agent_model_bindings_purpose_check"
  CHECK ("purpose" IN ('primary','default','coding','planning','review','fast','embedding'));
