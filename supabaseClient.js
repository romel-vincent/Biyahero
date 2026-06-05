    import { createClient } from '@supabase/supabase-js'

    const supabaseUrl = 'https://gfppsqhbvzluefvzvnev.supabase.co'
    const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmcHBzcWhidnpsdWVmdnp2bmV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3NjE1OTUsImV4cCI6MjA4NzMzNzU5NX0.gzcpIr_YktYdxbmjj-eoovWIgYpYQ9OnXXjYUwqMhQ4'

    const supabase = createClient(supabaseUrl, supabaseKey);

    export default supabase
