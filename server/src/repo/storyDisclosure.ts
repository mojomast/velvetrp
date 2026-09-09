/** SQL expressions are repository constants, never caller/provider input. */
export function publicStoryResourceSql(campaignExpression: string, resourceExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM campaign_generation_accepted_artifacts_v52 source
    WHERE source.campaign_id=${campaignExpression} AND source.visibility='gm' AND (
      source.server_resource_id=${resourceExpression}
      OR (source.artifact_kind='clue' AND json_extract(source.canonical_json,'$.revealsStoryNodeKey') IS NULL
        AND EXISTS (SELECT 1 FROM story_clue_sources_v34 origin
          WHERE origin.campaign_id=source.campaign_id AND origin.clue_id=source.server_resource_id
            AND origin.source_kind='node' AND origin.target_id=${resourceExpression}))))`;
}

/** A generated clue's synthetic anchor inherits its source visibility, even after a manual reveal. */
export function publicStorySourceSql(alias: string, idColumn: string): string {
  return publicStoryResourceSql(`${alias}.campaign_id`, `${alias}.${idColumn}`);
}
