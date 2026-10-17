import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { createArtifactBrokerHandler, createBoundedStorageFetch } from '../_shared/artifactBroker.ts'

const handler = createArtifactBrokerHandler({
  getEnvironment: (name) => Deno.env.get(name),
  createStorage: (url, serviceRoleKey) => {
    const bucket = Deno.env.get('APMS_AI_ARTIFACT_BUCKET')?.trim() || 'apms-ai-artifacts'
    const prefix = Deno.env.get('APMS_AI_ARTIFACT_PREFIX')?.trim() ?? ''
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: createBoundedStorageFetch(url, bucket, prefix) },
    })
    return client.storage
  },
})

Deno.serve(handler)
