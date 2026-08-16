package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var approveURL string

// explanationsApproveCmd clears the marked_for_review flag on a guessed explanation.
var explanationsApproveCmd = &cobra.Command{
	Use:   "approve",
	Short: "Approve a marked-for-review explanation",
	Long:  "Clear the marked_for_review flag on an explanation that FreeAgent guessed from a bank feed, confirming its category.",
	RunE: func(cmd *cobra.Command, args []string) error {
		reviewed := false
		explanation := freeagent.BankTransactionExplanation{
			MarkedForReview: &reviewed,
		}

		updatedExp, err := apiClient.UpdateBankTransactionExplanation(approveURL, explanation)
		if err != nil {
			return err
		}

		return formatOutput(updatedExp)
	},
}

func init() {
	explanationsCmd.AddCommand(explanationsApproveCmd)

	explanationsApproveCmd.Flags().StringVar(&approveURL, "url", "", "Explanation URI")
	_ = explanationsApproveCmd.MarkFlagRequired("url")
}
