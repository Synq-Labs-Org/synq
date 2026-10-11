import { MemoryReservationStore } from '@synq/settlement';
import { reservationScenarios } from './reservation-scenarios.js';

reservationScenarios('memory', async () => new MemoryReservationStore());
