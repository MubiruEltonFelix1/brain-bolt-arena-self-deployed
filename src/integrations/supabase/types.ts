export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      answers: {
        Row: {
          answer_value: Json | null
          created_at: string
          id: string
          is_correct: boolean
          participant_id: string
          points: number
          question_id: string
          response_ms: number
          selected_index: number
          session_id: string
          text_submission: string | null
        }
        Insert: {
          answer_value?: Json | null
          created_at?: string
          id?: string
          is_correct: boolean
          participant_id: string
          points?: number
          question_id: string
          response_ms: number
          selected_index: number
          session_id: string
          text_submission?: string | null
        }
        Update: {
          answer_value?: Json | null
          created_at?: string
          id?: string
          is_correct?: boolean
          participant_id?: string
          points?: number
          question_id?: string
          response_ms?: number
          selected_index?: number
          session_id?: string
          text_submission?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "answers_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      branding_profiles: {
        Row: {
          created_at: string
          id: string
          logo_url: string | null
          organization_name: string
          owner_id: string
          owner_principal_id: string | null
          primary_color: string | null
          secondary_color: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          logo_url?: string | null
          organization_name: string
          owner_id: string
          owner_principal_id?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          logo_url?: string | null
          organization_name?: string
          owner_id?: string
          owner_principal_id?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branding_profiles_owner_principal_id_fkey"
            columns: ["owner_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      competition_results: {
        Row: {
          accuracy_percentage: number
          completed_at: string
          final_rank: number
          final_score: number
          id: string
          profile_id: string
          quiz_id: string
          session_id: string | null
          total_participants: number
        }
        Insert: {
          accuracy_percentage?: number
          completed_at?: string
          final_rank: number
          final_score?: number
          id?: string
          profile_id: string
          quiz_id: string
          session_id?: string | null
          total_participants: number
        }
        Update: {
          accuracy_percentage?: number
          completed_at?: string
          final_rank?: number
          final_score?: number
          id?: string
          profile_id?: string
          quiz_id?: string
          session_id?: string | null
          total_participants?: number
        }
        Relationships: [
          {
            foreignKeyName: "competition_results_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competition_results_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competition_results_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      competitions: {
        Row: {
          autonomous: boolean
          branding_profile_id: string | null
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          description: string | null
          id: string
          league_id: string | null
          lobby_duration_seconds: number
          max_participants: number | null
          metadata: Json
          mode: Database["public"]["Enums"]["competition_mode"]
          owner_id: string
          owner_principal_id: string | null
          quiz_id: string
          scheduled_start_at: string | null
          session_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["competition_status"]
          title: string
          updated_at: string
          visibility: Database["public"]["Enums"]["competition_visibility"]
        }
        Insert: {
          autonomous?: boolean
          branding_profile_id?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          id?: string
          league_id?: string | null
          lobby_duration_seconds?: number
          max_participants?: number | null
          metadata?: Json
          mode?: Database["public"]["Enums"]["competition_mode"]
          owner_id: string
          owner_principal_id?: string | null
          quiz_id: string
          scheduled_start_at?: string | null
          session_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["competition_status"]
          title: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["competition_visibility"]
        }
        Update: {
          autonomous?: boolean
          branding_profile_id?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          id?: string
          league_id?: string | null
          lobby_duration_seconds?: number
          max_participants?: number | null
          metadata?: Json
          mode?: Database["public"]["Enums"]["competition_mode"]
          owner_id?: string
          owner_principal_id?: string | null
          quiz_id?: string
          scheduled_start_at?: string | null
          session_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["competition_status"]
          title?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["competition_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "competitions_branding_profile_id_fkey"
            columns: ["branding_profile_id"]
            isOneToOne: false
            referencedRelation: "branding_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitions_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitions_owner_principal_id_fkey"
            columns: ["owner_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      host_authorizations: {
        Row: {
          authorization_type: Database["public"]["Enums"]["host_auth_type"]
          created_at: string
          expires_at: string | null
          granted_by: string | null
          id: string
          notes: string | null
          profile_id: string
          remaining_sessions: number | null
          starts_at: string
          status: Database["public"]["Enums"]["host_auth_status"]
          updated_at: string
        }
        Insert: {
          authorization_type: Database["public"]["Enums"]["host_auth_type"]
          created_at?: string
          expires_at?: string | null
          granted_by?: string | null
          id?: string
          notes?: string | null
          profile_id: string
          remaining_sessions?: number | null
          starts_at?: string
          status?: Database["public"]["Enums"]["host_auth_status"]
          updated_at?: string
        }
        Update: {
          authorization_type?: Database["public"]["Enums"]["host_auth_type"]
          created_at?: string
          expires_at?: string | null
          granted_by?: string | null
          id?: string
          notes?: string | null
          profile_id?: string
          remaining_sessions?: number | null
          starts_at?: string
          status?: Database["public"]["Enums"]["host_auth_status"]
          updated_at?: string
        }
        Relationships: []
      }
      host_requests: {
        Row: {
          created_at: string
          expected_participants: Database["public"]["Enums"]["host_request_size"]
          id: string
          message: string | null
          organization: string
          purpose: Database["public"]["Enums"]["host_request_purpose"]
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["host_request_status"]
          user_id: string
        }
        Insert: {
          created_at?: string
          expected_participants: Database["public"]["Enums"]["host_request_size"]
          id?: string
          message?: string | null
          organization: string
          purpose: Database["public"]["Enums"]["host_request_purpose"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["host_request_status"]
          user_id: string
        }
        Update: {
          created_at?: string
          expected_participants?: Database["public"]["Enums"]["host_request_size"]
          id?: string
          message?: string | null
          organization?: string
          purpose?: Database["public"]["Enums"]["host_request_purpose"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["host_request_status"]
          user_id?: string
        }
        Relationships: []
      }
      league_quizzes: {
        Row: {
          created_at: string
          id: string
          league_id: string
          position: number
          quiz_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          league_id: string
          position?: number
          quiz_id: string
        }
        Update: {
          created_at?: string
          id?: string
          league_id?: string
          position?: number
          quiz_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_quizzes_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_quizzes_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      league_standings: {
        Row: {
          id: string
          league_id: string
          nickname: string
          sessions_played: number
          total_points: number
          updated_at: string
        }
        Insert: {
          id?: string
          league_id: string
          nickname: string
          sessions_played?: number
          total_points?: number
          updated_at?: string
        }
        Update: {
          id?: string
          league_id?: string
          nickname?: string
          sessions_played?: number
          total_points?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_standings_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      leagues: {
        Row: {
          archived_at: string | null
          cover_image_url: string | null
          created_at: string
          description: string | null
          end_date: string | null
          id: string
          name: string
          owner_id: string
          owner_principal_id: string | null
          points_first: number
          points_participation: number
          points_second: number
          points_third: number
          season: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["league_status"]
          updated_at: string
          visibility: Database["public"]["Enums"]["league_visibility"]
        }
        Insert: {
          archived_at?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          name: string
          owner_id: string
          owner_principal_id?: string | null
          points_first?: number
          points_participation?: number
          points_second?: number
          points_third?: number
          season?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["league_status"]
          updated_at?: string
          visibility?: Database["public"]["Enums"]["league_visibility"]
        }
        Update: {
          archived_at?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          name?: string
          owner_id?: string
          owner_principal_id?: string | null
          points_first?: number
          points_participation?: number
          points_second?: number
          points_third?: number
          season?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["league_status"]
          updated_at?: string
          visibility?: Database["public"]["Enums"]["league_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "leagues_owner_principal_id_fkey"
            columns: ["owner_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      participant_secrets: {
        Row: {
          created_at: string
          participant_id: string
          secret_token: string
        }
        Insert: {
          created_at?: string
          participant_id: string
          secret_token: string
        }
        Update: {
          created_at?: string
          participant_id?: string
          secret_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "participant_secrets_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: true
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
        ]
      }
      participants: {
        Row: {
          avatar_id: string | null
          id: string
          joined_at: string
          nickname: string
          profile_id: string | null
          score: number
          session_id: string
          streak: number
          team_id: string | null
        }
        Insert: {
          avatar_id?: string | null
          id?: string
          joined_at?: string
          nickname: string
          profile_id?: string | null
          score?: number
          session_id: string
          streak?: number
          team_id?: string | null
        }
        Update: {
          avatar_id?: string | null
          id?: string
          joined_at?: string
          nickname?: string
          profile_id?: string | null
          score?: number
          session_id?: string
          streak?: number
          team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "participants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participants_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participants_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      principals: {
        Row: {
          created_at: string
          id: string
          type: Database["public"]["Enums"]["principal_type"]
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id: string
          type: Database["public"]["Enums"]["principal_type"]
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          type?: Database["public"]["Enums"]["principal_type"]
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_id: string | null
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          username: string | null
          username_updated_at: string | null
        }
        Insert: {
          avatar_id?: string | null
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id: string
          username?: string | null
          username_updated_at?: string | null
        }
        Update: {
          avatar_id?: string | null
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          username?: string | null
          username_updated_at?: string | null
        }
        Relationships: []
      }
      questions: {
        Row: {
          accepted_answers: string[] | null
          audio_url: string | null
          correct_index: number
          correct_lat: number | null
          correct_lng: number | null
          correct_number: number | null
          created_at: string
          double_points: boolean
          id: string
          image_url: string | null
          max_distance_km: number | null
          number_max: number | null
          number_min: number | null
          number_tolerance: number | null
          options: Json
          point_value: number
          position: number
          question_type: string
          quiz_id: string
          reveal_stages: number | null
          text: string
          time_limit_sec: number | null
        }
        Insert: {
          accepted_answers?: string[] | null
          audio_url?: string | null
          correct_index: number
          correct_lat?: number | null
          correct_lng?: number | null
          correct_number?: number | null
          created_at?: string
          double_points?: boolean
          id?: string
          image_url?: string | null
          max_distance_km?: number | null
          number_max?: number | null
          number_min?: number | null
          number_tolerance?: number | null
          options: Json
          point_value?: number
          position?: number
          question_type?: string
          quiz_id: string
          reveal_stages?: number | null
          text: string
          time_limit_sec?: number | null
        }
        Update: {
          accepted_answers?: string[] | null
          audio_url?: string | null
          correct_index?: number
          correct_lat?: number | null
          correct_lng?: number | null
          correct_number?: number | null
          created_at?: string
          double_points?: boolean
          id?: string
          image_url?: string | null
          max_distance_km?: number | null
          number_max?: number | null
          number_min?: number | null
          number_tolerance?: number | null
          options?: Json
          point_value?: number
          position?: number
          question_type?: string
          quiz_id?: string
          reveal_stages?: number | null
          text?: string
          time_limit_sec?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      quizzes: {
        Row: {
          archived_at: string | null
          created_at: string
          description: string | null
          difficulty: string | null
          estimated_duration_minutes: number | null
          featured_rank: number | null
          id: string
          is_arena: boolean
          owner_id: string
          owner_principal_id: string | null
          play_count: number
          time_per_question: number
          title: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          description?: string | null
          difficulty?: string | null
          estimated_duration_minutes?: number | null
          featured_rank?: number | null
          id?: string
          is_arena?: boolean
          owner_id: string
          owner_principal_id?: string | null
          play_count?: number
          time_per_question?: number
          title: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          description?: string | null
          difficulty?: string | null
          estimated_duration_minutes?: number | null
          featured_rank?: number | null
          id?: string
          is_arena?: boolean
          owner_id?: string
          owner_principal_id?: string | null
          play_count?: number
          time_per_question?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "quizzes_owner_principal_id_fkey"
            columns: ["owner_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      result_claims: {
        Row: {
          accuracy: number
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          expires_at: string
          id: string
          kind: string
          metadata: Json
          participant_id: string | null
          quiz_id: string | null
          score: number
          token: string
        }
        Insert: {
          accuracy?: number
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          kind: string
          metadata?: Json
          participant_id?: string | null
          quiz_id?: string | null
          score?: number
          token: string
        }
        Update: {
          accuracy?: number
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          kind?: string
          metadata?: Json
          participant_id?: string | null
          quiz_id?: string | null
          score?: number
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_claims_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_claims_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          autonomous: boolean
          branding_profile_id: string | null
          code: string
          created_at: string
          current_question_index: number
          current_question_revealed: boolean
          current_question_started_at: string | null
          host_id: string
          id: string
          league_id: string | null
          paused_at: string | null
          question_order: Json | null
          quiz_id: string
          skipped_question_ids: string[]
          status: string
          team_mode: boolean
          time_added_ms: number
        }
        Insert: {
          autonomous?: boolean
          branding_profile_id?: string | null
          code: string
          created_at?: string
          current_question_index?: number
          current_question_revealed?: boolean
          current_question_started_at?: string | null
          host_id: string
          id?: string
          league_id?: string | null
          paused_at?: string | null
          question_order?: Json | null
          quiz_id: string
          skipped_question_ids?: string[]
          status?: string
          team_mode?: boolean
          time_added_ms?: number
        }
        Update: {
          autonomous?: boolean
          branding_profile_id?: string | null
          code?: string
          created_at?: string
          current_question_index?: number
          current_question_revealed?: boolean
          current_question_started_at?: string | null
          host_id?: string
          id?: string
          league_id?: string | null
          paused_at?: string | null
          question_order?: Json | null
          quiz_id?: string
          skipped_question_ids?: string[]
          status?: string
          team_mode?: boolean
          time_added_ms?: number
        }
        Relationships: [
          {
            foreignKeyName: "sessions_branding_profile_id_fkey"
            columns: ["branding_profile_id"]
            isOneToOne: false
            referencedRelation: "branding_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          session_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          session_id: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_question_time: {
        Args: { p_seconds: number; p_session_id: string }
        Returns: undefined
      }
      admin_approve_host_request:
        | { Args: { p_request_id: string }; Returns: string }
        | {
            Args: {
              p_authorization_type: Database["public"]["Enums"]["host_auth_type"]
              p_days?: number
              p_notes?: string
              p_request_id: string
              p_sessions?: number
            }
            Returns: string
          }
      admin_convert_host_authorization: {
        Args: {
          p_auth_id: string
          p_expires_at?: string
          p_sessions?: number
          p_type: Database["public"]["Enums"]["host_auth_type"]
        }
        Returns: undefined
      }
      admin_extend_host_authorization: {
        Args: {
          p_add_sessions?: number
          p_auth_id: string
          p_new_expires_at?: string
        }
        Returns: undefined
      }
      admin_grant_host_authorization: {
        Args: {
          p_expires_at?: string
          p_notes?: string
          p_profile_id: string
          p_sessions?: number
          p_type: Database["public"]["Enums"]["host_auth_type"]
        }
        Returns: string
      }
      admin_host_stats: {
        Args: never
        Returns: {
          active_hosts: number
          bundle_hosts: number
          expiring_soon: number
          single_hosts: number
          time_hosts: number
        }[]
      }
      admin_list_host_requests: {
        Args: { p_status?: Database["public"]["Enums"]["host_request_status"] }
        Returns: {
          created_at: string
          display_name: string
          email: string
          expected_participants: Database["public"]["Enums"]["host_request_size"]
          id: string
          message: string
          organization: string
          purpose: Database["public"]["Enums"]["host_request_purpose"]
          reviewed_at: string
          status: Database["public"]["Enums"]["host_request_status"]
          user_id: string
        }[]
      }
      admin_list_users: {
        Args: { p_search?: string }
        Returns: {
          auth_id: string
          authorization_type: Database["public"]["Enums"]["host_auth_type"]
          created_at: string
          display_name: string
          email: string
          expires_at: string
          id: string
          is_active: boolean
          remaining_sessions: number
          status: Database["public"]["Enums"]["host_auth_status"]
        }[]
      }
      admin_platform_stats: {
        Args: never
        Returns: {
          active_host_authorizations: number
          arena_plays: number
          arena_quizzes: number
          expiring_authorizations: number
          live_sessions: number
          pending_host_requests: number
          results_last_7d: number
          sessions_last_7d: number
          total_competitions: number
          total_players: number
          total_quizzes: number
        }[]
      }
      admin_reject_host_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      admin_revoke_host_authorization: {
        Args: { p_auth_id: string }
        Returns: undefined
      }
      advance_question: {
        Args: { p_session_id: string }
        Returns: {
          ended: boolean
          next_index: number
        }[]
      }
      advance_question_internal: {
        Args: { p_session_id: string }
        Returns: {
          ended: boolean
          next_index: number
        }[]
      }
      can:
        | { Args: { p_action: string; p_resource?: string }; Returns: boolean }
        | {
            Args: { p_action: string; p_principal: string; p_resource?: string }
            Returns: boolean
          }
      can_view_league: { Args: { p_league_id: string }; Returns: boolean }
      claim_result: { Args: { p_token: string }; Returns: Json }
      create_arena_claim: {
        Args: { p_answers: Json; p_quiz_id: string }
        Returns: string
      }
      create_session_claim: {
        Args: { p_participant_id: string; p_secret_token: string }
        Returns: string
      }
      current_principal_id: { Args: never; Returns: string }
      end_question_early: { Args: { p_session_id: string }; Returns: undefined }
      evaluate_question_answer: {
        Args: {
          p_answer: Json
          p_question_id: string
          p_response_ms: number
          p_streak: number
        }
        Returns: {
          correctness: number
          is_correct: boolean
          points: number
        }[]
      }
      get_arena_questions: {
        Args: { p_quiz_id: string }
        Returns: {
          q_accepted_answers: string[]
          q_audio_url: string
          q_correct_index: number
          q_correct_lat: number
          q_correct_lng: number
          q_correct_number: number
          q_double_points: boolean
          q_id: string
          q_image_url: string
          q_max_distance_km: number
          q_number_max: number
          q_number_min: number
          q_number_tolerance: number
          q_options: Json
          q_point_value: number
          q_position: number
          q_question_type: string
          q_reveal_stages: number
          q_text: string
          q_time_limit_sec: number
        }[]
      }
      get_arena_quiz_detail: {
        Args: { p_quiz_id: string }
        Returns: {
          avg_accuracy: number
          created_at: string
          creator_name: string
          description: string
          difficulty: string
          estimated_duration_minutes: number
          id: string
          last_updated: string
          play_count: number
          question_count: number
          time_per_question: number
          title: string
        }[]
      }
      get_arena_quizzes: {
        Args: never
        Returns: {
          avg_accuracy: number
          creator_name: string
          description: string
          difficulty: string
          estimated_duration_minutes: number
          featured_rank: number
          id: string
          last_updated: string
          play_count: number
          question_count: number
          time_per_question: number
          title: string
        }[]
      }
      get_league_overview: {
        Args: { p_league_id: string }
        Returns: {
          competitions_completed: number
          competitions_total: number
          competitions_upcoming: number
          participant_count: number
        }[]
      }
      get_league_standings: {
        Args: { p_league_id: string }
        Returns: {
          avatar_id: string
          avg_accuracy: number
          competitions_played: number
          display_name: string
          league_points: number
          podiums: number
          profile_id: string
          standing_position: number
          total_score: number
          wins: number
        }[]
      }
      get_my_leagues: {
        Args: never
        Returns: {
          archived_at: string
          competitions_played: number
          last_played_at: string
          league_id: string
          league_points: number
          name: string
          standing_position: number
          status: Database["public"]["Enums"]["league_status"]
        }[]
      }
      get_my_round_result: {
        Args: {
          p_participant_id: string
          p_question_id: string
          p_secret_token: string
        }
        Returns: {
          answer_value: Json
          answered: boolean
          correct_index: number
          correct_lat: number
          correct_lng: number
          correct_number: number
          correct_text: string
          is_correct: boolean
          points: number
          selected_index: number
          text_submission: string
          total_score: number
        }[]
      }
      get_round_progress: {
        Args: { p_question_id: string; p_session_id: string }
        Returns: {
          answered_count: number
          total_count: number
        }[]
      }
      get_round_stats: {
        Args: { p_question_id: string; p_session_id: string }
        Returns: {
          selected_index: number
          vote_count: number
        }[]
      }
      get_server_time: { Args: never; Returns: string }
      get_session_answer_key: {
        Args: { p_session_id: string }
        Returns: {
          correct_index: number
          correct_lat: number
          correct_lng: number
          correct_number: number
          correct_text: string
          question_id: string
        }[]
      }
      get_session_questions: {
        Args: { p_session_id: string }
        Returns: {
          q_audio_url: string
          q_double_points: boolean
          q_id: string
          q_image_url: string
          q_max_distance_km: number
          q_number_max: number
          q_number_min: number
          q_options: Json
          q_point_value: number
          q_position: number
          q_question_type: string
          q_quiz_id: string
          q_reveal_stages: number
          q_text: string
          q_time_limit_sec: number
        }[]
      }
      has_active_host_authorization: {
        Args: { p_user: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      haversine_km: {
        Args: { lat1: number; lat2: number; lng1: number; lng2: number }
        Returns: number
      }
      is_admin: { Args: never; Returns: boolean }
      is_authorized_host: { Args: never; Returns: boolean }
      is_session_host: { Args: { p_session_id: string }; Returns: boolean }
      join_session:
        | {
            Args: { p_code: string; p_nickname: string; p_team_id?: string }
            Returns: {
              participant_id: string
              secret_token: string
              session_id: string
            }[]
          }
        | {
            Args: {
              p_avatar_id?: string
              p_code: string
              p_nickname: string
              p_team_id?: string
            }
            Returns: {
              participant_id: string
              secret_token: string
              session_id: string
            }[]
          }
      list_due_competitions: {
        Args: never
        Returns: {
          id: string
          lobby_opens_at: string
          scheduled_start_at: string
          title: string
        }[]
      }
      lookup_game_code: {
        Args: { p_code: string }
        Returns: {
          autonomous: boolean
          code: string
          competition_title: string
          kind: string
          lobby_opens_at: string
          quiz_title: string
          scheduled_start_at: string
          session_id: string
          session_status: string
          team_mode: boolean
        }[]
      }
      normalize_text_answer: { Args: { s: string }; Returns: string }
      pause_session: { Args: { p_session_id: string }; Returns: undefined }
      prepare_competition_session: {
        Args: { p_competition_id: string; p_force?: boolean }
        Returns: {
          code: string
          created: boolean
          session_id: string
          status: Database["public"]["Enums"]["competition_status"]
        }[]
      }
      prepare_competition_session_internal: {
        Args: { p_competition_id: string; p_force?: boolean }
        Returns: {
          code: string
          created: boolean
          session_id: string
          status: Database["public"]["Enums"]["competition_status"]
        }[]
      }
      principal_for_user: { Args: { p_user: string }; Returns: string }
      resume_session: { Args: { p_session_id: string }; Returns: undefined }
      reveal_current_question: {
        Args: { p_session_id: string }
        Returns: undefined
      }
      run_autonomous_scheduler: {
        Args: { p_interval_seconds?: number; p_seconds?: number }
        Returns: undefined
      }
      run_autonomous_tick: {
        Args: never
        Returns: {
          action: string
          session_id: string
        }[]
      }
      score_answer: {
        Args: {
          p_correctness: number
          p_double: boolean
          p_graded: boolean
          p_point_value: number
          p_response_ms: number
          p_streak: number
          p_time_limit_ms: number
        }
        Returns: number
      }
      score_arena_run: {
        Args: { p_answers: Json; p_quiz_id: string }
        Returns: {
          accuracy: number
          correct_count: number
          graded_count: number
          score: number
        }[]
      }
      skip_current_question: {
        Args: { p_session_id: string }
        Returns: {
          ended: boolean
          next_index: number
        }[]
      }
      submit_answer: {
        Args: {
          p_participant_id: string
          p_question_id: string
          p_response_ms: number
          p_secret_token: string
          p_selected_index: number
        }
        Returns: {
          accepted: boolean
          new_streak: number
        }[]
      }
      submit_arena_run: {
        Args: { p_answers: Json; p_quiz_id: string; p_run_id: string }
        Returns: {
          accuracy: number
          correct_count: number
          graded_count: number
          score: number
        }[]
      }
      submit_geo_answer: {
        Args: {
          p_lat: number
          p_lng: number
          p_participant_id: string
          p_question_id: string
          p_response_ms: number
          p_secret_token: string
        }
        Returns: {
          accepted: boolean
          distance_km: number
          points: number
        }[]
      }
      submit_host_request: {
        Args: {
          p_expected: Database["public"]["Enums"]["host_request_size"]
          p_message: string
          p_organization: string
          p_purpose: Database["public"]["Enums"]["host_request_purpose"]
        }
        Returns: string
      }
      submit_number_answer: {
        Args: {
          p_participant_id: string
          p_question_id: string
          p_response_ms: number
          p_secret_token: string
          p_value: number
        }
        Returns: {
          accepted: boolean
          diff: number
          points: number
        }[]
      }
      submit_ordering_answer: {
        Args: {
          p_order: number[]
          p_participant_id: string
          p_question_id: string
          p_response_ms: number
          p_secret_token: string
        }
        Returns: {
          accepted: boolean
          correct_positions: number
          points: number
        }[]
      }
      submit_text_answer: {
        Args: {
          p_participant_id: string
          p_question_id: string
          p_response_ms: number
          p_secret_token: string
          p_text: string
        }
        Returns: {
          accepted: boolean
          is_correct: boolean
          points: number
        }[]
      }
      user_for_principal: { Args: { p_principal: string }; Returns: string }
    }
    Enums: {
      app_role: "admin" | "host"
      competition_mode: "hosted" | "arena" | "scheduled"
      competition_status:
        | "draft"
        | "scheduled"
        | "lobby_open"
        | "running"
        | "completed"
        | "cancelled"
      competition_visibility: "private" | "unlisted" | "public"
      host_auth_status: "active" | "expired" | "revoked" | "consumed"
      host_auth_type: "single" | "bundle" | "time"
      host_request_purpose:
        | "university"
        | "company"
        | "association"
        | "community"
        | "other"
      host_request_size: "1-25" | "26-50" | "51-100"
      host_request_status: "pending" | "approved" | "rejected"
      league_status: "draft" | "registration_open" | "active" | "completed"
      league_visibility: "public" | "private"
      principal_type: "user" | "organization" | "platform" | "partner"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "host"],
      competition_mode: ["hosted", "arena", "scheduled"],
      competition_status: [
        "draft",
        "scheduled",
        "lobby_open",
        "running",
        "completed",
        "cancelled",
      ],
      competition_visibility: ["private", "unlisted", "public"],
      host_auth_status: ["active", "expired", "revoked", "consumed"],
      host_auth_type: ["single", "bundle", "time"],
      host_request_purpose: [
        "university",
        "company",
        "association",
        "community",
        "other",
      ],
      host_request_size: ["1-25", "26-50", "51-100"],
      host_request_status: ["pending", "approved", "rejected"],
      league_status: ["draft", "registration_open", "active", "completed"],
      league_visibility: ["public", "private"],
      principal_type: ["user", "organization", "platform", "partner"],
    },
  },
} as const
