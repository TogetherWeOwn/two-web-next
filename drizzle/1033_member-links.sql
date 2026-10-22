CREATE TABLE member_links (
  user_id text PRIMARY KEY NOT NULL,
  links jsonb DEFAULT '[]'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE member_links ADD CONSTRAINT member_links_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users("id") ON DELETE cascade ON UPDATE no action;
