/** Optimistic offline projection.
 *
 *  When the device is offline, scored deliveries are queued locally. To keep
 *  the scoreboard truthful we replay those queued deliveries through the very
 *  same deterministic engine the server uses. Because the engine is a pure
 *  function of (state, input), the projected state offline is identical to the
 *  state the server will derive once the queue is pushed. */

import { applyDelivery } from '../../domain/engine';
import type { DeliveryInput as EngineInput, InningsState as EngineState, MatchRules as EngineRules } from '../../domain/types';
import type { DeliveryInput, InningsState, MatchRules } from './types';

export function replayQueued(base: InningsState, rules: MatchRules, queued: DeliveryInput[]): InningsState {
  let state = base as unknown as EngineState;
  for (const input of queued) {
    const result = applyDelivery(
      state,
      input as unknown as EngineInput,
      rules as unknown as EngineRules,
      { skipValidation: true },
    );
    state = result.state;
  }
  return state as unknown as InningsState;
}
