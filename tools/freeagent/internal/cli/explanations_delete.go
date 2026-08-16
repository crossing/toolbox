package cli

import (
	"github.com/spf13/cobra"
)

var deleteURL string

var explanationsDeleteCmd = &cobra.Command{
	Use:   "delete",
	Short: "Delete a bank transaction explanation",
	Long:  "Delete an explanation, returning its bank transaction to the unexplained state.",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := apiClient.Delete(deleteURL); err != nil {
			return err
		}

		return formatOutput(map[string]string{"deleted": deleteURL})
	},
}

func init() {
	explanationsCmd.AddCommand(explanationsDeleteCmd)

	explanationsDeleteCmd.Flags().StringVar(&deleteURL, "url", "", "Explanation URI")
	_ = explanationsDeleteCmd.MarkFlagRequired("url")
}
