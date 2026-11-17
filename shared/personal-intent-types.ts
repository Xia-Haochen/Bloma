export interface PersonalExperience {
  summary: string
  commitments: Array<{ id: string; statement: string; source_ids: string[]; feature_ids: string[];
    scenario_ids: string[]; unacceptable_substitute: string }>
}


export interface DesignAsset { attachment_id: string; sha256: string; role: 'required_asset' | 'style_reference' | 'content'; usage: string; transformations: string }
