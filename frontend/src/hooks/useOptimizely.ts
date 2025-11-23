/**
 * Custom hook to access Optimizely client
 * Wraps the Optimizely React SDK context for easier access
 */

import { useContext } from 'react';
import { OptimizelyContext } from '@optimizely/react-sdk';

export function useOptimizely() {
  const context = useContext(OptimizelyContext);
  return {
    optimizely: context?.optimizely || null,
    isServerSide: context?.isServerSide || false,
  };
}

